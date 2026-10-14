/**
 * Compare two sorted files line by line, as GNU `comm` does: column 1 is the lines only in FILE1, column 2 those only in FILE2,
 * column 3 the lines in both. `-1`, `-2` and `-3` leave a column out, `--output-delimiter` replaces the tab, `--total` adds the
 * counts, and unsorted input is reported once (the output is still written). Lines are compared as bytes.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`comm: ${text}\n`))

const usage = `Usage: comm [OPTION]... FILE1 FILE2
Compare sorted files FILE1 and FILE2 line by line.

  -1                      suppress column 1 (lines unique to FILE1)
  -2                      suppress column 2 (lines unique to FILE2)
  -3                      suppress column 3 (lines that appear in both files)
  --check-order           check that the input is correctly sorted, even if all input lines are pairable
  --nocheck-order         do not check that the input is correctly sorted
  --output-delimiter=STR  separate columns with STR
  --total                 output a summary
  -z, --zero-terminated   line delimiter is NUL, not newline
  --help                  display this help and exit

With no FILE, or when FILE is -, read standard input.`

const decode = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }

function readFd(fd) {
  const chunks = []
  let total = 0
  for (;;) {
    const buffer = new Uint8Array(65536)
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
    total += n
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  return bytes
}

function main() {
  const args = argv.slice(1)
  const hide = [false, false, false]
  let delimiter = '\t'
  let check = 'default'
  let total = false
  let zero = false
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg === '--check-order') { check = 'yes'; continue }
    if (arg === '--nocheck-order') { check = 'no'; continue }
    if (arg === '--total') { total = true; continue }
    if (arg === '--zero-terminated') { zero = true; continue }
    const long = /^--output-delimiter(?:=(.*))?$/.exec(arg)
    if (long) { delimiter = long[1] !== undefined ? long[1] : args[++i]; if (delimiter === '') { err('empty --output-delimiter not allowed'); return 1 } continue }
    if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'comm --help' for more information."); return 1 }
    for (const flag of arg.slice(1)) {
      if (flag === '1' || flag === '2' || flag === '3') hide[Number(flag) - 1] = true
      else if (flag === 'z') zero = true
      else { err(`invalid option -- '${flag}'`); err("Try 'comm --help' for more information."); return 1 }
    }
  }

  if (files.length < 2) { err(files.length ? `missing operand after '${files[0]}'` : 'missing operand'); err("Try 'comm --help' for more information."); return 1 }
  if (files.length > 2) { err(`extra operand '${files[2]}'`); err("Try 'comm --help' for more information."); return 1 }

  const end = zero ? '\0' : '\n'
  const cwd = getcwd()
  const lists = []
  for (const file of files) {
    try {
      let text
      if (file === '-') text = decode(readFd(0))
      else {
        const fullPath = resolve(cwd, file)
        if (isDirectory(fullPath)) { err(`${file}: read error: Is a directory`); return 1 }
        const fd = open(fullPath, O_RDONLY)
        try { text = decode(readFd(fd)) } finally { close(fd) }
      }
      const lines = text === '' ? [] : text.split(end)
      if (lines.length && lines[lines.length - 1] === '') lines.pop()
      lists.push(lines)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      return 1
    }
  }

  // A column is prefixed by one delimiter for each earlier column that is shown
  const prefix = column => delimiter.repeat(hide.slice(0, column).filter(hidden => !hidden).length)
  const counts = [0, 0, 0]
  let out = ''
  const emit = (column, line) => {
    counts[column]++
    if (!hide[column]) out += prefix(column) + line + end
  }

  const [a, b] = lists
  let i = 0
  let j = 0
  const disorder = [false, false]
  const reported = [false, false]
  const checkNext = (list, index, which) => {
    if (index > 0 && list[index] < list[index - 1]) disorder[which] = true
  }

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { emit(2, a[i]); i++; j++ }
    else if (a[i] < b[j]) { emit(0, a[i]); i++; checkNext(a, i, 0) }
    else { emit(1, b[j]); j++; checkNext(b, j, 1) }
  }
  while (i < a.length) { emit(0, a[i]); i++; checkNext(a, i, 0) }
  while (j < b.length) { emit(1, b[j]); j++; checkNext(b, j, 1) }

  if (total) out += `${counts[0]}${delimiter}${counts[1]}${delimiter}${counts[2]}${delimiter}total${end}`
  writeAll(1, Uint8Array.from(out, ch => ch.charCodeAt(0)))

  let status = 0
  if (check !== 'no') {
    disorder.forEach((bad, which) => {
      if (bad && !reported[which]) { err(`file ${which + 1} is not in sorted order`); reported[which] = true; status = 1 }
    })
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
