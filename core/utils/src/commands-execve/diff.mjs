/**
 * `diff`: compare files line by line as GNU diff does. The edit script is found with the same algorithm (the divide-and-conquer
 * longest common subsequence of GNU's `diffseq`, lines nobody else has dropped first, changed runs slid to merge with their
 * neighbours), so the hunks come out where GNU's do. Output formats: normal, `-c`/`-C` context, `-u`/`-U` unified, `-e` and
 * `-f` ed scripts, `-n` RCS, `-y` side by side, `-q` brief; `-i -b -w -B -E -Z --strip-trailing-cr -I` ignore differences;
 * directories compare by name, with `-r` going down and `-N` treating an absent file as empty.
 */

import { getopt } from './lib/getopt.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { resolve } from './lib/path-utils.mjs'
import { reasonOf } from './lib/errno.mjs'

const { argv, exit, writeAll, getcwd, stat, readdir, isDirectory } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
/** Lines are kept as bytes, one character each, so what is printed is what was read whatever the encoding */
const latin1 = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }
/** A name as such byte characters */
const asBytes = text => latin1(encoder.encode(text))
const outParts = []
const out = text => { outParts.push(text); if (outParts.length > 512) flush() }
const flush = () => { if (outParts.length) { const bytes = Uint8Array.from(outParts.join(''), char => char.charCodeAt(0)); outParts.length = 0; let at = 0; while (at < bytes.length) at += globalThis.ecmaosSyscalls.write(1, bytes.subarray(at), -1) } }
const err = text => { flush(); writeAll(2, encoder.encode(`diff: ${text}\n`)) }

const usage = `Usage: diff [OPTION]... FILES
Compare FILES line by line.

Mandatory arguments to long options are mandatory for short options too.
      --normal                  output a normal diff (the default)
  -q, --brief                   report only when files differ
  -s, --report-identical-files  report when two files are the same
  -c, -C NUM, --context[=NUM]   output NUM (default 3) lines of copied context
  -u, -U NUM, --unified[=NUM]   output NUM (default 3) lines of unified context
  -e, --ed                      output an ed script
  -n, --rcs                     output an RCS format diff
  -y, --side-by-side            output in two columns
  -W, --width=NUM               output at most NUM (default 130) print columns
      --left-column             output only the left column of common lines
      --suppress-common-lines   do not output common lines
  -L, --label LABEL             use LABEL instead of file name and timestamp
  -a, --text                    treat all files as text
  -i, --ignore-case             ignore case differences in file contents
  -E, --ignore-tab-expansion    ignore changes due to tab expansion
  -Z, --ignore-trailing-space   ignore white space at line end
  -b, --ignore-space-change     ignore changes in the amount of white space
  -w, --ignore-all-space        ignore all white space
  -B, --ignore-blank-lines      ignore changes where lines are all blank
  -I, --ignore-matching-lines=RE  ignore changes where all lines match RE
      --strip-trailing-cr       strip trailing carriage return on input
  -r, --recursive               recursively compare any subdirectories found
  -N, --new-file                treat absent files as empty
  -x, --exclude=PAT             exclude files that match PAT
  -d, --minimal                 try hard to find a smaller set of changes
      --help                    display this help and exit`

// - the comparison ---------------------------------------------------------------------------------------------------

/** The lines of a file (each without its newline), whether the last one had none, and the raw text */
function splitLines(bytes, { stripCr }) {
  const text = latin1(bytes)
  if (text === '') return { lines: [], noNewline: false }
  const noNewline = !text.endsWith('\n')
  const lines = text.split('\n')
  if (!noNewline) lines.pop()
  if (stripCr) for (let i = 0; i < lines.length; i++) if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1)
  return { lines, noNewline }
}

/** What two lines are compared by, under the ignore options */
function keyOf(line, o) {
  let key = line
  if (o.ignoreTabExpansion) key = key.replace(/\t/g, ' ')
  if (o.ignoreTrailingSpace) key = key.replace(/[ \t\r\f\v]+$/, '')
  if (o.ignoreAllSpace) key = key.replace(/[ \t\r\f\v]+/g, '')
  else if (o.ignoreSpaceChange) key = key.replace(/[ \t\r\f\v]+/g, ' ').replace(/ $/, '')
  if (o.ignoreCase) key = key.toLowerCase()
  return key
}

const SNAKE_LIMIT = 20
const OFFSET_MAX = 2 ** 30

/**
 * GNU's compareseq over the arrays `a` and `b` of equivalence classes: calls `del(i)` for a line of `a` with no counterpart and
 * `ins(j)` for one of `b`, in order.
 */
function compareseq(a, b, del, ins) {
  const size = a.length + b.length + 3
  const fd = new Int32Array(size)
  const bd = new Int32Array(size)
  const shift = b.length + 1
  const same = (x, y) => a[x] === b[y]

  function diag(xoff, xlim, yoff, ylim) {
    const dmin = xoff - ylim
    const dmax = xlim - yoff
    const fmid = xoff - yoff
    const bmid = xlim - ylim
    let fmin = fmid, fmax = fmid, bmin = bmid, bmax = bmid
    const odd = ((fmid - bmid) & 1) !== 0
    fd[fmid + shift] = xoff
    bd[bmid + shift] = xlim
    for (let c = 1; ; c++) {
      if (fmin > dmin) fd[--fmin - 1 + shift] = -1
      else ++fmin
      if (fmax < dmax) fd[++fmax + 1 + shift] = -1
      else --fmax
      for (let d = fmax; d >= fmin; d -= 2) {
        const tlo = fd[d - 1 + shift]
        const thi = fd[d + 1 + shift]
        const x0 = tlo < thi ? thi : tlo + 1
        let x = x0
        let y = x0 - d
        while (x < xlim && y < ylim && same(x, y)) { x++; y++ }
        fd[d + shift] = x
        if (odd && bmin <= d && d <= bmax && bd[d + shift] <= x) return { xmid: x, ymid: y }
      }
      if (bmin > dmin) bd[--bmin - 1 + shift] = OFFSET_MAX
      else ++bmin
      if (bmax < dmax) bd[++bmax + 1 + shift] = OFFSET_MAX
      else --bmax
      for (let d = bmax; d >= bmin; d -= 2) {
        const tlo = bd[d - 1 + shift]
        const thi = bd[d + 1 + shift]
        const x0 = tlo < thi ? tlo : thi - 1
        let x = x0
        let y = x0 - d
        while (xoff < x && yoff < y && same(x - 1, y - 1)) { x--; y-- }
        bd[d + shift] = x
        if (!odd && fmin <= d && d <= fmax && x <= fd[d + shift]) return { xmid: x, ymid: y }
      }
    }
  }

  function run(xoff, xlim, yoff, ylim) {
    while (xoff < xlim && yoff < ylim && same(xoff, yoff)) { xoff++; yoff++ }
    while (xoff < xlim && yoff < ylim && same(xlim - 1, ylim - 1)) { xlim--; ylim-- }
    if (xoff === xlim) while (yoff < ylim) ins(yoff++)
    else if (yoff === ylim) while (xoff < xlim) del(xoff++)
    else {
      const { xmid, ymid } = diag(xoff, xlim, yoff, ylim)
      run(xoff, xmid, yoff, ymid)
      run(xmid, xlim, ymid, ylim)
    }
  }
  run(0, a.length, 0, b.length)
}

/** Which lines of each file are changed, as GNU computes it, from the equivalence classes of the lines of both */
function changedLines(eq0, eq1) {
  const n0 = eq0.length
  const n1 = eq1.length
  const count0 = new Map()
  const count1 = new Map()
  for (const id of eq0) count0.set(id, (count0.get(id) ?? 0) + 1)
  for (const id of eq1) count1.set(id, (count1.get(id) ?? 0) + 1)
  // lines with no equal in the other file are changed for certain, and stay out of the search
  const keep0 = []
  const keep1 = []
  for (let i = 0; i < n0; i++) if (count1.has(eq0[i])) keep0.push(i)
  for (let j = 0; j < n1; j++) if (count0.has(eq1[j])) keep1.push(j)
  // arrays with a sentinel unchanged line on each side: line k is at k + 1
  const changed0 = new Uint8Array(n0 + 2).fill(1)
  const changed1 = new Uint8Array(n1 + 2).fill(1)
  changed0[0] = changed0[n0 + 1] = 0
  changed1[0] = changed1[n1 + 1] = 0
  for (const i of keep0) changed0[i + 1] = 0
  for (const j of keep1) changed1[j + 1] = 0
  compareseq(keep0.map(i => eq0[i]), keep1.map(j => eq1[j]), x => { changed0[keep0[x] + 1] = 1 }, y => { changed1[keep1[y] + 1] = 1 })
  shiftBoundaries(changed0, changed1, eq0, n0)
  shiftBoundaries(changed1, changed0, eq1, n1)
  return [changed0, changed1]
}

/**
 * GNU's `shift_boundaries`: a run of changed lines slides up or down past lines equal to the ones at its other end, so that
 * it merges with a neighbouring run, or, failing that, lines up with a run of changes in the other file.
 */
function shiftBoundaries(changed, other, equivs, length) {
  // changed[k + 1] is line k
  const c = k => changed[k + 1]
  const setC = (k, v) => { changed[k + 1] = v }
  const o = k => other[k + 1]
  let i = 0
  let j = 0
  const end = length
  for (;;) {
    while (i < end && !c(i)) {
      while (o(j++)) continue
      i++
    }
    if (i === end) break
    let start = i
    while (c(++i)) continue
    while (o(j)) j++
    let runlength
    let corresponding
    do {
      runlength = i - start
      while (start && equivs[start - 1] === equivs[i - 1]) {
        setC(--start, 1)
        setC(--i, 0)
        while (c(start - 1)) start--
        while (o(--j)) continue
      }
      corresponding = o(j - 1) ? i : end
      while (i !== end && equivs[start] === equivs[i]) {
        setC(start++, 0)
        setC(i++, 1)
        while (c(i)) i++
        while (o(++j)) corresponding = i
      }
    } while (runlength !== i - start)
    while (corresponding < i) {
      setC(--start, 1)
      setC(--i, 0)
      while (o(--j)) continue
    }
  }
}

/** The runs of changes as `{ line0, deleted, line1, inserted }` (line numbers from 0), in order */
function scriptOf(changed0, changed1, n0, n1) {
  const script = []
  let i = 0
  let j = 0
  while (i < n0 || j < n1) {
    if (i < n0 && j < n1 && !changed0[i + 1] && !changed1[j + 1]) { i++; j++; continue }
    const line0 = i
    const line1 = j
    while (i < n0 && changed0[i + 1]) i++
    while (j < n1 && changed1[j + 1]) j++
    script.push({ line0, deleted: i - line0, line1, inserted: j - line1 })
  }
  return script
}

// - output formats ---------------------------------------------------------------------------------------------------

const range = (start, count) => (count === 1 ? String(start + 1) : count === 0 ? String(start) : `${start + 1},${start + count}`)
const unifiedRange = (start, count) => (count === 1 ? String(start + 1) : `${count === 0 ? start : start + 1},${count}`)

/** Groups changes into hunks: changes whose unchanged gap is at most twice the context stay together */
function hunksOf(script, context) {
  const hunks = []
  for (const change of script) {
    const last = hunks[hunks.length - 1]
    if (last) {
      const previous = last[last.length - 1]
      if (change.line0 - (previous.line0 + previous.deleted) <= 2 * context) { last.push(change); continue }
    }
    hunks.push([change])
  }
  return hunks
}

const MISSING = '\\ No newline at end of file\n'

function printNormal(a, b, script) {
  for (const change of script) {
    const { line0, deleted, line1, inserted } = change
    out(`${range(line0, deleted)}${deleted === 0 ? 'a' : inserted === 0 ? 'd' : 'c'}${range(line1, inserted)}\n`)
    for (let k = line0; k < line0 + deleted; k++) { out(`< ${a.lines[k]}\n`); if (k === a.lines.length - 1 && a.noNewline) out(MISSING) }
    if (deleted && inserted) out('---\n')
    for (let k = line1; k < line1 + inserted; k++) { out(`> ${b.lines[k]}\n`); if (k === b.lines.length - 1 && b.noNewline) out(MISSING) }
  }
}

function printUnified(a, b, script, context, labels) {
  out(`--- ${labels[0]}\n+++ ${labels[1]}\n`)
  for (const hunk of hunksOf(script, context)) {
    const first = hunk[0]
    const last = hunk[hunk.length - 1]
    const from0 = Math.max(0, first.line0 - context)
    const to0 = Math.min(a.lines.length, last.line0 + last.deleted + context)
    const from1 = from0 + (first.line1 - first.line0)
    const to1 = to0 + (last.line1 + last.inserted - (last.line0 + last.deleted))
    out(`@@ -${unifiedRange(from0, to0 - from0)} +${unifiedRange(from1, to1 - from1)} @@\n`)
    const lineOut = (prefix, file, k) => { out(`${prefix}${file.lines[k]}\n`); if (k === file.lines.length - 1 && file.noNewline) out(MISSING) }
    let i = from0
    for (const change of hunk) {
      for (; i < change.line0; i++) lineOut(' ', a, i)
      for (let k = 0; k < change.deleted; k++) lineOut('-', a, change.line0 + k)
      for (let k = 0; k < change.inserted; k++) lineOut('+', b, change.line1 + k)
      i = change.line0 + change.deleted
    }
    for (; i < to0; i++) lineOut(' ', a, i)
  }
}

function printContext(a, b, script, context, labels) {
  out(`*** ${labels[0]}\n--- ${labels[1]}\n`)
  for (const hunk of hunksOf(script, context)) {
    const first = hunk[0]
    const last = hunk[hunk.length - 1]
    const from0 = Math.max(0, first.line0 - context)
    const to0 = Math.min(a.lines.length, last.line0 + last.deleted + context)
    const from1 = from0 + (first.line1 - first.line0)
    const to1 = to0 + (last.line1 + last.inserted - (last.line0 + last.deleted))
    out('***************\n')
    const side = (file, from, to, header, mark, ownKey, otherKey, startKey) => {
      out(`${header(from, to - from)}\n`)
      if (!hunk.some(change => change[ownKey] > 0)) return
      let k = from
      const lineOut = (prefix, index) => { out(`${prefix}${file.lines[index]}\n`); if (index === file.lines.length - 1 && file.noNewline) out(MISSING) }
      for (const change of hunk) {
        for (; k < change[startKey]; k++) lineOut('  ', k)
        for (let m = 0; m < change[ownKey]; m++) lineOut(change[otherKey] > 0 ? '! ' : mark, change[startKey] + m)
        k = change[startKey] + change[ownKey]
      }
      for (; k < to; k++) lineOut('  ', k)
    }
    const header = (prefix, suffix) => (from, count) => `${prefix}${count === 0 ? from : count === 1 ? from + 1 : `${from + 1},${from + count}`} ${suffix}`
    side(a, from0, to0, header('*** ', '****'), '- ', 'deleted', 'inserted', 'line0')
    side(b, from1, to1, header('--- ', '----'), '+ ', 'inserted', 'deleted', 'line1')
  }
}

function printEd(a, b, script, forward) {
  const lines = []
  const ordered = forward ? script : [...script].reverse()
  for (const { line0, deleted, line1, inserted } of ordered) {
    const body = []
    for (let k = 0; k < inserted; k++) body.push(b.lines[line1 + k])
    if (forward) {
      const command = deleted === 0 ? `a${line0}` : inserted === 0 ? `d${range(line0, deleted)}` : `c${range(line0, deleted)}`
      lines.push(command.replace(/^([acd])(\d+),(\d+)$/, '$1$2 $3'))
    } else {
      lines.push(`${range(line0, deleted)}${deleted === 0 ? 'a' : inserted === 0 ? 'd' : 'c'}`.replace(/^(\d+),(\d+)(.)$/, '$1,$2$3'))
    }
    if (inserted) { lines.push(...body); lines.push('.') }
  }
  for (const text of lines) out(text + '\n')
}

function printRcs(a, b, script) {
  for (const { line0, deleted, line1, inserted } of script) {
    if (deleted) out(`d${line0 + 1} ${deleted}\n`)
    if (inserted) {
      out(`a${line0 + deleted} ${inserted}\n`)
      for (let k = 0; k < inserted; k++) out(`${b.lines[line1 + k]}\n`)
    }
  }
}

/** The width of a line on the screen with tabs, and the line cut to `limit` columns */
function cut(text, limit) {
  let column = 0
  let shown = ''
  for (const char of text) {
    const width = char === '\t' ? 8 - (column % 8) : 1
    if (column + width > limit) break
    shown += char === '\t' ? ' '.repeat(width) : char
    column += width
  }
  return [shown, column]
}

function padTo(column, target) {
  let text = ''
  while (Math.floor(column / 8) * 8 + 8 <= target) { text += '\t'; column = Math.floor(column / 8) * 8 + 8 }
  while (column < target) { text += ' '; column++ }
  return text
}

function printSideBySide(a, b, script, o) {
  const width = o.width
  const t = width - 6
  const q = Math.floor(t / 16)
  const m = t - q * 16
  const half = Math.max(0, m < 8 ? 8 * q - 2 + m : 8 * q + 5)
  const col2 = 8 * Math.floor((width - 5) / 16) + 8
  const gutter = Math.min(Math.floor((width - 1) / 2), col2 - 2)
  const common = (k, kb) => {
    if (o.suppressCommon) return
    const [left, column] = cut(a.lines[k], half)
    if (o.leftColumn) { out(`${left}${padTo(column, gutter)}(\n`); return }
    const [right] = cut(b.lines[kb], half)
    out(`${left}${padTo(column, col2)}${right}\n`)
  }
  const changed = (leftLine, rightLine, mark) => {
    let text = ''
    let column = 0
    if (leftLine !== undefined) { const [left, c] = cut(leftLine, half); text = left; column = c }
    text += padTo(column, gutter) + mark
    if (rightLine !== undefined) { const [right] = cut(rightLine, half); text += padTo(gutter + 1, col2) + right }
    out(text + '\n')
  }
  let i = 0
  let j = 0
  for (const change of script) {
    while (i < change.line0) common(i++, j++)
    const pairs = Math.min(change.deleted, change.inserted)
    for (let k = 0; k < pairs; k++) {
      const lacks = (a.noNewline && change.line0 + k === a.lines.length - 1) || (b.noNewline && change.line1 + k === b.lines.length - 1)
      changed(a.lines[change.line0 + k], b.lines[change.line1 + k], lacks ? '\\' : '|')
    }
    for (let k = pairs; k < change.deleted; k++) changed(a.lines[change.line0 + k], undefined, '<')
    for (let k = pairs; k < change.inserted; k++) changed(undefined, b.lines[change.line1 + k], '>')
    i = change.line0 + change.deleted
    j = change.line1 + change.inserted
  }
  while (i < a.lines.length) common(i++, j++)
}

// - files ------------------------------------------------------------------------------------------------------------

const isDir = path => { try { return isDirectory(path) } catch { return false } }

function stamp(path) {
  try {
    const s = stat(path)
    const date = new Date(s.mtimeMs)
    const pad = (n, w = 2) => String(n).padStart(w, '0')
    const nanos = String(Math.floor((s.mtimeMs % 1000) * 1e6)).padStart(9, '0')
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${nanos} +0000`
  } catch { return '1970-01-01 00:00:00.000000000 +0000' }
}

/** Compares two files: returns 0 when they are the same, 1 when they differ, 2 when one cannot be read */
function compareFiles(name0, name1, path0, path1, o) {
  let bytes0
  let bytes1
  try { bytes0 = name0 === '-' ? readFdBytes(0) : path0 === undefined ? new Uint8Array() : readFileBytes(path0) } catch (error) {
    err(`${name0}: ${reasonOf(error)}`)
    return 2
  }
  try { bytes1 = name1 === '-' ? readFdBytes(0) : path1 === undefined ? new Uint8Array() : readFileBytes(path1) } catch (error) {
    err(`${name1}: ${reasonOf(error)}`)
    return 2
  }
  const binary = !o.text && (bytes0.subarray(0, 4096).includes(0) || bytes1.subarray(0, 4096).includes(0))
  const a = splitLines(bytes0, o)
  const b = splitLines(bytes1, o)
  const ids = new Map()
  const idOf = (key, noNewline) => {
    const full = noNewline ? key + '\u0000\\' : key
    let id = ids.get(full)
    if (id === undefined) { id = ids.size; ids.set(full, id) }
    return id
  }
  const eq0 = a.lines.map((line, k) => idOf(keyOf(line, o), a.noNewline && k === a.lines.length - 1))
  const eq1 = b.lines.map((line, k) => idOf(keyOf(line, o), b.noNewline && k === b.lines.length - 1))
  const [changed0, changed1] = changedLines(eq0, eq1)
  let script = scriptOf(changed0, changed1, a.lines.length, b.lines.length)
  if (o.ignoreBlankLines) {
    script = script.filter(change => {
      for (let k = 0; k < change.deleted; k++) if (a.lines[change.line0 + k].trim() !== '') return true
      for (let k = 0; k < change.inserted; k++) if (b.lines[change.line1 + k].trim() !== '') return true
      return false
    })
  }
  if (o.ignoreMatching.length) {
    script = script.filter(change => {
      const lines = [...a.lines.slice(change.line0, change.line0 + change.deleted), ...b.lines.slice(change.line1, change.line1 + change.inserted)]
      return !lines.every(line => o.ignoreMatching.some(re => re.test(line)))
    })
  }
  if (script.length === 0) {
    if (o.reportIdentical) out(`Files ${asBytes(name0)} and ${asBytes(name1)} are identical\n`)
    return 0
  }
  if (binary) { out(`Binary files ${asBytes(name0)} and ${asBytes(name1)} differ\n`); return 1 }
  if (o.brief) { out(`Files ${asBytes(name0)} and ${asBytes(name1)} differ\n`); return 1 }
  if (o.header) out(`${asBytes(o.header)}\n`)
  const names = [asBytes(o.labels[0] ?? `${name0}\t${stamp(path0 ?? '')}`), asBytes(o.labels[1] ?? `${name1}\t${stamp(path1 ?? '')}`)]
  if (o.format === 'unified') printUnified(a, b, script, o.context, names)
  else if (o.format === 'context') printContext(a, b, script, o.context, names)
  else if (o.format === 'ed') printEd(a, b, script, false)
  else if (o.format === 'forward-ed') printEd(a, b, script, true)
  else if (o.format === 'rcs') printRcs(a, b, script)
  else if (o.format === 'side') printSideBySide(a, b, script, o)
  else printNormal(a, b, script)
  return 1
}

function listDirectory(path) {
  try { return readdir(path).map(entry => (typeof entry === 'string' ? entry : entry.name)).filter(name => name !== '.' && name !== '..') } catch { return [] }
}

const matchesExclude = (name, patterns) => patterns.some(pattern => new RegExp('^' + pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(name))

/** Compares two paths, going into directories as the options say */
function compare(name0, name1, o, top) {
  const cwd = getcwd()
  const path0 = name0 === '-' ? name0 : resolve(cwd, name0)
  const path1 = name1 === '-' ? name1 : resolve(cwd, name1)
  const exists = p => { try { stat(p); return true } catch { return false } }
  const dir0 = name0 !== '-' && isDir(path0)
  const dir1 = name1 !== '-' && isDir(path1)
  if (dir0 && dir1) {
    let status = 0
    const names = [...new Set([...listDirectory(path0), ...listDirectory(path1)])].sort()
    for (const entry of names) {
      if (matchesExclude(entry, o.exclude)) continue
      const sub0 = `${name0.replace(/\/$/, '')}/${entry}`
      const sub1 = `${name1.replace(/\/$/, '')}/${entry}`
      const e0 = exists(resolve(cwd, sub0))
      const e1 = exists(resolve(cwd, sub1))
      if (e0 && e1) {
        if (isDir(resolve(cwd, sub0)) && isDir(resolve(cwd, sub1))) {
          if (o.recursive) status = Math.max(status, compare(sub0, sub1, o, false))
          else out(`Common subdirectories: ${asBytes(sub0)} and ${asBytes(sub1)}\n`)
          continue
        }
        const d0 = isDir(resolve(cwd, sub0))
        const d1 = isDir(resolve(cwd, sub1))
        if (d0 !== d1) { out(`File ${asBytes(sub0)} is a ${d0 ? 'directory' : 'regular file'} while file ${asBytes(sub1)} is a ${d1 ? 'directory' : 'regular file'}\n`); status = Math.max(status, 1); continue }
        status = Math.max(status, compareInDirectory(sub0, sub1, o))
      } else if (o.newFile || (!e0 && !e1)) {
        status = Math.max(status, compareInDirectory(sub0, sub1, o))
      } else { out(`Only in ${asBytes(e0 ? name0 : name1)}: ${asBytes(entry)}\n`); status = Math.max(status, 1) }
    }
    return status
  }
  if (dir0 || dir1) {
    // a directory and a file: the file is looked for in the directory
    const dir = dir0 ? name0 : name1
    const file = dir0 ? name1 : name0
    const base = file.split('/').pop()
    const inside = `${dir.replace(/\/$/, '')}/${base}`
    if (!exists(resolve(cwd, inside))) { err(`${inside}: No such file or directory`); return 2 }
    // a file against a directory compares it with the file of that name there, with no header line
    return dir0 ? compareFiles(inside, name1, resolve(cwd, inside), resolve(cwd, name1), o) : compareFiles(name0, inside, resolve(cwd, name0), resolve(cwd, inside), o)
  }
  if (name0 !== '-' && !exists(path0) && !o.newFile) { err(`${name0}: No such file or directory`); return 2 }
  if (name1 !== '-' && !exists(path1) && !o.newFile) { err(`${name1}: No such file or directory`); return 2 }
  return compareFiles(name0, name1, name0 !== '-' && exists(path0) ? path0 : name0 === '-' ? undefined : undefined, name1 !== '-' && exists(path1) ? path1 : undefined, o)
}

function compareInDirectory(name0, name1, o) {
  const cwd = getcwd()
  const exists = p => { try { stat(p); return true } catch { return false } }
  const p0 = resolve(cwd, name0)
  const p1 = resolve(cwd, name1)
  const header = `diff ${o.echo.length ? o.echo.join(' ') + ' ' : ''}${name0} ${name1}`
  return compareFiles(name0, name1, exists(p0) ? p0 : undefined, exists(p1) ? p1 : undefined, { ...o, header: o.brief ? undefined : header }, undefined)
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'abBcC:dEefF:hHiI:lL:nNpqrsS:tTuU:vwW:x:X:yZ',
    long: {
      normal: 'normal', brief: 'q', 'report-identical-files': 's', context: { key: 'c', arg: 'optional' }, unified: { key: 'u', arg: 'optional' }, ed: 'e', rcs: 'n',
      'side-by-side': 'y', width: { key: 'W', arg: 'required' }, 'left-column': 'left-column', 'suppress-common-lines': 'suppress', label: { key: 'L', arg: 'required' },
      text: 'a', 'ignore-case': 'i', 'ignore-tab-expansion': 'E', 'ignore-trailing-space': 'Z', 'ignore-space-change': 'b', 'ignore-all-space': 'w',
      'ignore-blank-lines': 'B', 'ignore-matching-lines': { key: 'I', arg: 'required' }, 'strip-trailing-cr': 'strip-cr', recursive: 'r', 'new-file': 'N',
      exclude: { key: 'x', arg: 'required' }, minimal: 'd', 'speed-large-files': 'speed', 'show-c-function': 'p', 'expand-tabs': 't', 'initial-tab': 'T', help: 'help', version: 'version',
      color: { key: 'color', arg: 'optional' }, 'no-dereference': 'no-deref', 'ignore-file-name-case': 'ignore-file-case', 'horizon-lines': { key: 'horizon', arg: 'required' },
      'from-file': { key: 'from-file', arg: 'required' }, 'to-file': { key: 'to-file', arg: 'required' }, forward: 'f'
    }
  })
  if (error) { err(error); err("Try 'diff --help' for more information."); return 2 }
  const o = {
    format: 'normal', context: 3, width: 130, labels: [], ignoreCase: false, ignoreAllSpace: false, ignoreSpaceChange: false, ignoreTrailingSpace: false,
    ignoreTabExpansion: false, ignoreBlankLines: false, ignoreMatching: [], stripCr: false, brief: false, reportIdentical: false, text: false, recursive: false,
    newFile: false, exclude: [], suppressCommon: false, leftColumn: false, echo: []
  }
  const echoes = []
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('diff (ecmaOS diffutils)\n'); return 0 }
    else if (key === 'normal') o.format = 'normal'
    else if (key === 'q') o.brief = true
    else if (key === 's') o.reportIdentical = true
    else if (key === 'c' || key === 'C') { o.format = 'context'; if (value !== true && value !== undefined) { const n = Number(value); if (!Number.isInteger(n) || n < 0) { err(`invalid context length ‘${value}’`); return 2 } o.context = n } }
    else if (key === 'u' || key === 'U') { o.format = 'unified'; if (value !== true && value !== undefined) { const n = Number(value); if (!Number.isInteger(n) || n < 0) { err(`invalid context length ‘${value}’`); return 2 } o.context = n } }
    else if (key === 'e') o.format = 'ed'
    else if (key === 'f') o.format = 'forward-ed'
    else if (key === 'n') o.format = 'rcs'
    else if (key === 'y') o.format = 'side'
    else if (key === 'W') { const n = Number(value); if (!Number.isInteger(n) || n < 1) { err(`invalid width ‘${value}’`); return 2 } o.width = n }
    else if (key === 'left-column') o.leftColumn = true
    else if (key === 'suppress') o.suppressCommon = true
    else if (key === 'L') { if (o.labels.length >= 2) { err('extra operand'); return 2 } o.labels.push(value) }
    else if (key === 'a') o.text = true
    else if (key === 'i') o.ignoreCase = true
    else if (key === 'E') o.ignoreTabExpansion = true
    else if (key === 'Z') o.ignoreTrailingSpace = true
    else if (key === 'b') o.ignoreSpaceChange = true
    else if (key === 'w') o.ignoreAllSpace = true
    else if (key === 'B') o.ignoreBlankLines = true
    else if (key === 'I') { try { o.ignoreMatching.push(new RegExp(value)) } catch { err(`invalid regular expression ‘${value}’`); return 2 } }
    else if (key === 'strip-cr') o.stripCr = true
    else if (key === 'r') { o.recursive = true; echoes.push('-r') }
    else if (key === 'N') { o.newFile = true; echoes.push('-N') }
    else if (key === 'x') o.exclude.push(value)
  }
  o.echo = echoes
  if (operands.length === 0) { err('missing operand after ‘diff’'); err("Try 'diff --help' for more information."); return 2 }
  if (operands.length === 1) { err(`missing operand after ‘${operands[0]}’`); err("Try 'diff --help' for more information."); return 2 }
  if (operands.length > 2) { err(`extra operand ‘${operands[2]}’`); err("Try 'diff --help' for more information."); return 2 }
  return compare(operands[0], operands[1], o, true)
}

try {
  const status = main()
  flush()
  exit(status)
} catch (error) {
  flush()
  writeAll(2, encoder.encode(`diff: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(2)
}
