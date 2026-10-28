/**
 * Three-way comparison as GNU `diff3` does it: OLDER and MINE are each diffed against YOURS with the same
 * engine `diff` uses, hunks of the two diffs that touch in YOURS are joined into one block, and each block is typed by which
 * files differ. Files are arrays of lines; `last` marks a final line with no newline, which differs from the same line with one.
 */

import { changedLines, scriptOf } from './diff-core.mjs'

/** The files are indexed 0 MINE, 1 OLDER, 2 YOURS throughout */
export const NAMES = ['mine', 'older', 'yours']

/**
 * @param {Array<{ lines: string[], noNewline: boolean }>} files MINE, OLDER, YOURS
 * @returns {Array<{ type: '' | '1' | '2' | '3', ranges: Array<[number, number]> }>} blocks in order; a range is `[start, end)` in lines from 0
 */
export function diff3(files, base = 2) {
  const ids = new Map()
  const classes = files.map(({ lines, noNewline }) => lines.map((line, k) => {
    const key = noNewline && k === lines.length - 1 ? line + '\u0000\\' : line
    let id = ids.get(key)
    if (id === undefined) { id = ids.size; ids.set(key, id) }
    return id
  }))
    // The blocks are measured in one file, the base: GNU diffs the other two against it, and which side a run of equal lines
  // slides to depends on that choice. The listing is measured in YOURS (`diff OLDER YOURS`, `diff MINE YOURS`), the merge in OLDER.
  const others = [0, 1, 2].filter(f => f !== base)
  const hunks = side => {
    const [changedOther, changedBase] = changedLines(classes[side], classes[base])
    return scriptOf(changedOther, changedBase, classes[side].length, classes[base].length).map(change => ({
      side, start: change.line1, end: change.line1 + change.inserted, size: change.deleted - change.inserted
    }))
  }
  const all = others.flatMap(hunks).sort((a, b) => a.start - b.start || a.end - b.end)

  // hunks that overlap or touch in the base are one block
  const groups = []
  for (const hunk of all) {
    const last = groups[groups.length - 1]
    if (last && hunk.start <= last.end) { last.end = Math.max(last.end, hunk.end); last.hunks.push(hunk) } else groups.push({ start: hunk.start, end: hunk.end, hunks: [hunk] })
  }

  const blocks = []
  const offset = [0, 0, 0]
  for (const group of groups) {
    const ranges = [null, null, null]
    ranges[base] = [group.start, group.end]
    for (const side of others) {
      const delta = group.hunks.filter(hunk => hunk.side === side).reduce((sum, hunk) => sum + hunk.size, 0)
      ranges[side] = [group.start + offset[side], group.end + offset[side] + delta]
      offset[side] += delta
    }
    const same = (a, b) => ranges[a][1] - ranges[a][0] === ranges[b][1] - ranges[b][0]
      && classes[a].slice(ranges[a][0], ranges[a][1]).every((id, k) => id === classes[b][ranges[b][0] + k])
    const mineOlder = same(0, 1)
    const olderYours = same(1, 2)
    const mineYours = same(0, 2)
    if (mineOlder && olderYours) continue
    blocks.push({ type: mineYours ? '2' : olderYours ? '1' : mineOlder ? '3' : '', ranges })
  }
  return blocks
}

/** `N:` then the range as diff writes it: `3a` for an empty range after line 3, `3c` for one line, `3,5c` for several */
const rangeText = ([start, end]) => (end === start ? `${start}a` : end - start === 1 ? `${start + 1}c` : `${start + 1},${end}c`)

/** The default output: each block as `====`, then the range and the lines of each file */
export function formatDefault(files, blocks) {
  let out = ''
  for (const block of blocks) {
    out += `====${block.type}\n`
    // GNU lists the files in order, except that YOURS comes before OLDER when OLDER is the one that differs
    for (const f of block.type === '2' ? [0, 2, 1] : [0, 1, 2]) {
      const [start, end] = block.ranges[f]
      out += `${f + 1}:${rangeText(block.ranges[f])}\n`
      // of the two files that agree, the first gets its range but not its lines
      if (f === { '1': 1, '2': 0, '3': 0 }[block.type]) continue
      for (let k = start; k < end; k++) {
        out += `  ${files[f].lines[k]}\n`
        if (files[f].noNewline && k === files[f].lines.length - 1) out += '\\ No newline at end of file\n'
      }
    }
  }
  return out
}

/**
 * The merged file: unchanged lines, then for each block what the sides agree on, or a conflict marked with
 * `<<<<<<< LABEL`, `=======` and `>>>>>>> LABEL`. `showAll` adds the OLDER lines to a conflict after `||||||| LABEL`.
 * @returns {{ text: string, conflicts: number }}
 */
export function formatMerge(files, blocks, { labels, showAll = false }) {
  const lines = (f, [start, end]) => files[f].lines.slice(start, end)
  let out = ''
  let conflicts = 0
  let at = 0
  for (const block of blocks) {
    const [olderStart, olderEnd] = block.ranges[1]
    for (; at < olderStart; at++) out += files[1].lines[at] + '\n'
    let chosen
    if (block.type === '2' && showAll) {
      // with -A a change both sides made is shown too, as OLDER between the markers and then what they made
      conflicts++
      out += `<<<<<<< ${labels[1]}\n`
      for (const line of lines(1, block.ranges[1])) out += line + '\n'
      out += '=======\n'
      for (const line of lines(2, block.ranges[2])) out += line + '\n'
      out += `>>>>>>> ${labels[2]}\n`
      at = olderEnd
      continue
    }
    if (block.type === '1' || block.type === '2') chosen = lines(0, block.ranges[0])
    else if (block.type === '3') chosen = lines(2, block.ranges[2])
    if (chosen) for (const line of chosen) out += line + '\n'
    else {
      conflicts++
      out += `<<<<<<< ${labels[0]}\n`
      for (const line of lines(0, block.ranges[0])) out += line + '\n'
      if (showAll) {
        out += `||||||| ${labels[1]}\n`
        for (const line of lines(1, block.ranges[1])) out += line + '\n'
      }
      out += '=======\n'
      for (const line of lines(2, block.ranges[2])) out += line + '\n'
      out += `>>>>>>> ${labels[2]}\n`
    }
    at = olderEnd
  }
  for (; at < files[1].lines.length; at++) out += files[1].lines[at] + '\n'
  return { text: out, conflicts }
}
