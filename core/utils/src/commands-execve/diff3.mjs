/**
 * `diff3`: compare three files line by line as GNU does (`diff3 MINE OLDER YOURS`). The default output lists the blocks where
 * the files differ; `-m` writes the merged file with conflicts bracketed (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`), `-m -E`
 * without the OLDER lines. The ed-script forms (`-e -x -3 -X`) are not provided.
 */

import { diff3, formatDefault, formatMerge } from './lib/diff3-core.mjs'
import { getopt } from './lib/getopt.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { reasonOf } from './lib/errno.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
// Files are compared as bytes; a line goes out as it came in
const latin1 = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }
const out = text => { const bytes = Uint8Array.from(text, char => char.charCodeAt(0)); let at = 0; while (at < bytes.length) at += writeAll(1, bytes.subarray(at)) ?? bytes.length }
const err = text => writeAll(2, encoder.encode(`diff3: ${text}\n`))

const usage = `Usage: diff3 [OPTION]... MINE OLDER YOURS
Compare three files line by line.

  -A, --show-all              with -m, bracket conflicts and show the OLDER lines (the default of -m)
  -E, --show-overlap          with -m, bracket conflicts without the OLDER lines
  -m, --merge                 output the merged file
  -L, --label=LABEL           use LABEL instead of the file name (up to three times)
  -a, --text                  treat all files as text
      --help                  display this help and exit
  -v, --version               output version information and exit

If a FILE is '-', read standard input. The ed script options (-e -x -3 -X) are not provided.
Exit status is 0 if there is no conflict, 1 if there is one (with -m), 2 on trouble.`

function lines(bytes) {
  const text = latin1(bytes)
  if (text === '') return { lines: [], noNewline: false }
  const noNewline = !text.endsWith('\n')
  const parts = text.split('\n')
  if (!noNewline) parts.pop()
  return { lines: parts, noNewline }
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'AEmL:aexX3iTv',
    long: { 'show-all': 'A', 'show-overlap': 'E', merge: 'm', label: { key: 'L', arg: 'required' }, text: 'a', ed: 'e', 'easy-only': '3', 'overlap-only': 'x', 'initial-tab': 'T', help: 'help', version: 'v' }
  })
  if (error) { err(error); return 2 }
  const labels = []
  let merge = false
  let showAll = true
  for (const [key, value] of options) {
    if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'v') { writeAll(1, encoder.encode('diff3 (ecmaOS coreutils) 1.0\n')); return 0 }
    if (key === 'm') merge = true
    else if (key === 'E') showAll = false
    else if (key === 'A') showAll = true
    else if (key === 'L') labels.push(value)
    else if ('exX3i'.includes(key)) { err('ed script output is not provided (use -m for the merged file)'); return 2 }
  }
  if (labels.length > 3) { err('too many file label options'); return 2 }
  if (operands.length !== 3) { err(operands.length < 3 ? `missing operand after ‘${operands[operands.length - 1] ?? 'diff3'}’` : `extra operand ‘${operands[3]}’`); return 2 }
  if (operands.filter(name => name === '-').length > 1) { err('Only one file can be standard input'); return 2 }

  const files = []
  for (const name of operands) {
    try { files.push(lines(name === '-' ? readFdBytes(0) : readFileBytes(name))) } catch (e) { err(`${name}: ${reasonOf(e)}`); return 2 }
  }
  if (merge) {
    // the merge measures its blocks in OLDER, the listing in YOURS: GNU does, and they can differ where equal lines slide
    const { text, conflicts } = formatMerge(files, diff3(files, 1), { labels: [labels[0] ?? operands[0], labels[1] ?? operands[1], labels[2] ?? operands[2]], showAll })
    out(text)
    return conflicts ? 1 : 0
  }
  out(formatDefault(files, diff3(files)))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(2)
}
