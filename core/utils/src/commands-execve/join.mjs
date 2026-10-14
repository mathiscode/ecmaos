/**
 * Join lines of two sorted files on a common field, as GNU `join` does: the join field, then the other fields of each file.
 * `-1 F`, `-2 F` and `-j F` choose the fields, `-t CHAR` the separator, `-a N` also prints the unpairable lines of file N, `-v N`
 * prints only those, `-e STR` fills empty fields, `-o LIST` sets the output (`0`, `1.2`, `2.1`), and `-i` ignores case. Fields are
 * compared as bytes; input that is not sorted on the join field is reported and the status is 1.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`join: ${text}\n`))

const usage = `Usage: join [OPTION]... FILE1 FILE2
For each pair of input lines with identical join fields, write a line to standard output. The default join field is the first,
delimited by blanks.

  -a FILENUM        also print unpairable lines from file FILENUM, where FILENUM is 1 or 2
  -e STRING         replace missing input fields with STRING
  -i, --ignore-case ignore differences in case when comparing fields
  -j FIELD          equivalent to '-1 FIELD -2 FIELD'
  -o FORMAT         obey FORMAT while constructing output line
  -t CHAR           use CHAR as input and output field separator
  -v FILENUM        like -a FILENUM, but suppress joined output lines
  -1 FIELD          join on this FIELD of file 1
  -2 FIELD          join on this FIELD of file 2
  -z, --zero-terminated  line delimiter is NUL, not newline
  --help            display this help and exit

FORMAT is one or more comma or blank separated specifications, each being 'FILENUM.FIELD' or '0' (the join field).`

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
  const fields = [1, 1]
  const unpairable = [false, false]
  const onlyUnpairable = [false, false]
  let empty = ''
  let format
  let separator
  let ignoreCase = false
  let zero = false
  let checkOrder = 'default'
  const files = []

  const fileNumber = (text, flag) => {
    if (text !== '1' && text !== '2') { err(`invalid file number: '${text}'`); return undefined }
    return Number(text) - 1
  }
  const fieldNumber = text => {
    if (!/^\d+$/.test(text ?? '') || Number(text) === 0) { err(`invalid field number: '${text ?? ''}'`); return undefined }
    return Number(text)
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg === '--ignore-case') { ignoreCase = true; continue }
    if (arg === '--zero-terminated') { zero = true; continue }
    if (arg === '--check-order') { checkOrder = 'yes'; continue }
    if (arg === '--nocheck-order') { checkOrder = 'no'; continue }
    if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'join --help' for more information."); return 1 }
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'i') ignoreCase = true
      else if (flag === 'z') zero = true
      else if ('aveotj12'.includes(flag)) {
        const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        if (value === undefined) { err(`option requires an argument -- '${flag}'`); err("Try 'join --help' for more information."); return 1 }
        if (flag === 'a' || flag === 'v') {
          const which = fileNumber(value)
          if (which === undefined) return 1
          unpairable[which] = true
          if (flag === 'v') onlyUnpairable[which] = true
        } else if (flag === 'e') empty = value
        else if (flag === 'o') format = value
        else if (flag === 't') {
          if (value.length > 1 && value !== '\\0') { err(`multi-character tab '${value}'`); return 1 }
          separator = value === '\\0' ? '\0' : value
        } else {
          const number = fieldNumber(value)
          if (number === undefined) return 1
          if (flag === 'j') { fields[0] = number; fields[1] = number }
          else fields[Number(flag) - 1] = number
        }
        break
      } else { err(`invalid option -- '${flag}'`); err("Try 'join --help' for more information."); return 1 }
    }
  }

  if (files.length < 2) { err(files.length ? `missing operand after '${files[0]}'` : 'missing operand'); err("Try 'join --help' for more information."); return 1 }
  if (files.length > 2) { err(`extra operand '${files[2]}'`); err("Try 'join --help' for more information."); return 1 }
  if (files[0] === '-' && files[1] === '-') { err('both files cannot be standard input'); return 1 }

  const end = zero ? '\0' : '\n'
  const cwd = getcwd()

  /** `-o` as a list of [file, field], where field 0 is the join field */
  let outputs
  if (format !== undefined && format !== 'auto') {
    outputs = []
    for (const part of format.split(/[,\s]+/).filter(Boolean)) {
      const match = /^(?:0|([12])\.(\d+))$/.exec(part)
      if (!match) { err(`invalid field specifier: '${part}'`); return 1 }
      outputs.push(part === '0' ? [0, 0] : [Number(match[1]), Number(match[2])])
    }
  }

  const split = line => (separator === undefined ? line.replace(/^[ \t]+/, '').split(/[ \t]+/).filter((_, index, all) => !(index === all.length - 1 && all[index] === '') || all.length === 1) : line.split(separator))
  const keyOf = (parts, which) => {
    const key = parts[fields[which] - 1] ?? ''
    return ignoreCase ? key.replace(/[a-z]/g, ch => ch.toUpperCase()) : key
  }

  const sides = []
  // Unsorted input is reported when it matters: with --check-order always, otherwise only if some line has no partner
  const disorders = []
  let failed = false
  let hadUnpairable = false
  for (let which = 0; which < 2; which++) {
    const name = files[which]
    let text
    try {
      if (name === '-') text = decode(readFd(0))
      else {
        const fullPath = resolve(cwd, name)
        if (isDirectory(fullPath)) { err(`${name}: Is a directory`); return 1 }
        const fd = open(fullPath, O_RDONLY)
        try { text = decode(readFd(fd)) } finally { close(fd) }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${name}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      return 1
    }
    const lines = text === '' ? [] : text.split(end)
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    const rows = lines.map((line, index) => ({ line, parts: split(line), number: index + 1 }))
    rows.forEach(row => { row.key = keyOf(row.parts, which) })
    for (let k = 1; k < rows.length; k++) {
      if (rows[k].key < rows[k - 1].key) { disorders.push(`${name}:${rows[k].number}: is not sorted: ${rows[k].line}`); break }
    }
    sides.push(rows)
  }

  const joiner = separator === undefined ? ' ' : separator
  const fieldText = (row, which, field) => {
    const value = field === 0 ? row.parts[fields[which] - 1] : row.parts[field - 1]
    return value === undefined || value === '' ? empty : value
  }
  const format1 = (a, b) => {
    if (outputs) {
      return outputs.map(([file, field]) => {
        if (file === 0) return a ? fieldText(a, 0, 0) || (b ? fieldText(b, 1, 0) : empty) : fieldText(b, 1, 0)
        const row = file === 1 ? a : b
        return row ? fieldText(row, file - 1, field) : empty
      }).join(joiner)
    }
    const row = a ?? b
    const which = a ? 0 : 1
    const rest = (r, w) => r.parts.filter((_, index) => index !== fields[w] - 1)
    const key = row.parts[fields[which] - 1] ?? ''
    return [key, ...(a ? rest(a, 0) : []), ...(b ? rest(b, 1) : [])].join(joiner)
  }

  const [left, right] = sides
  let out = ''
  let i = 0
  let j = 0
  const skipPaired = onlyUnpairable[0] || onlyUnpairable[1]
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i].key === right[j].key) {
      // All the lines with this key on each side pair with each other
      let li = i
      while (li < left.length && left[li].key === left[i].key) li++
      let rj = j
      while (rj < right.length && right[rj].key === right[j].key) rj++
      if (!skipPaired) for (let x = i; x < li; x++) for (let y = j; y < rj; y++) out += format1(left[x], right[y]) + end
      i = li
      j = rj
    } else if (j >= right.length || (i < left.length && left[i].key < right[j].key)) {
      hadUnpairable = true
      if (unpairable[0] || onlyUnpairable[0]) out += format1(left[i], undefined) + end
      i++
    } else {
      hadUnpairable = true
      if (unpairable[1] || onlyUnpairable[1]) out += format1(undefined, right[j]) + end
      j++
    }
  }

  writeAll(1, Uint8Array.from(out, ch => ch.charCodeAt(0)))
  if (disorders.length && (checkOrder === 'yes' || (checkOrder === 'default' && hadUnpairable))) {
    for (const message of disorders) err(message)
    err('input is not in sorted order')
    failed = true
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
