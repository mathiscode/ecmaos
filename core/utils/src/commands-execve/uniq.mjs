/**
 * Report or omit repeated lines, as GNU `uniq` does: adjacent equal lines are one. `-c` prefixes counts, `-d` prints only
 * repeated lines, `-D` all of them, `-u` only unique ones, `-i` ignores case, `-f N` skips fields, `-s N` skips characters, `-w N`
 * compares at most N characters, and `-z` takes NUL-terminated lines. An output file may follow the input.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, write, isDirectory, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`uniq: ${text}\n`))

const usage = `Usage: uniq [OPTION]... [INPUT [OUTPUT]]
Filter adjacent matching lines from INPUT (or standard input), writing to OUTPUT (or standard output).

  -c, --count           prefix lines by the number of occurrences
  -d, --repeated        only print duplicate lines, one for each group
  -D                    print all duplicate lines
  -f, --skip-fields=N   avoid comparing the first N fields
  -i, --ignore-case     ignore differences in case when comparing
  -s, --skip-chars=N    avoid comparing the first N characters
  -u, --unique          only print unique lines
  -z, --zero-terminated line delimiter is NUL, not newline
  -w, --check-chars=N   compare no more than N characters in lines
  --help                display this help and exit

A field is a run of blanks (usually spaces and/or TABs), then non-blank characters. Fields are skipped before chars.`

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

const isBlank = ch => ch === ' ' || ch === '\t'

function main() {
  const args = argv.slice(1)
  let count = false
  let repeated = false
  let allRepeated = false
  let unique = false
  let ignoreCase = false
  let zero = false
  let skipFields = 0
  let skipChars = 0
  let checkChars = Infinity
  const operands = []

  const number = (text, what) => {
    if (!/^\d+$/.test(text ?? '')) { err(`${text ?? ''}: invalid number of ${what}`); return undefined }
    return Number(text)
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { operands.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { operands.push(arg); continue }

    if (arg.startsWith('--')) {
      const [name, inline] = arg.split(/=(.*)/s)
      const value = () => (inline !== undefined ? inline : args[++i])
      if (name === '--count') count = true
      else if (name === '--repeated') repeated = true
      else if (name === '--all-repeated') allRepeated = true
      else if (name === '--unique') unique = true
      else if (name === '--ignore-case') ignoreCase = true
      else if (name === '--zero-terminated') zero = true
      else if (name === '--skip-fields') { skipFields = number(value(), 'fields to skip'); if (skipFields === undefined) return 1 }
      else if (name === '--skip-chars') { skipChars = number(value(), 'bytes to skip'); if (skipChars === undefined) return 1 }
      else if (name === '--check-chars') { checkChars = number(value(), 'bytes to compare'); if (checkChars === undefined) return 1 }
      else { err(`unrecognized option '${arg}'`); err("Try 'uniq --help' for more information."); return 1 }
      continue
    }

    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'c') count = true
      else if (flag === 'd') repeated = true
      else if (flag === 'D') allRepeated = true
      else if (flag === 'u') unique = true
      else if (flag === 'i') ignoreCase = true
      else if (flag === 'z') zero = true
      else if ('fsw'.includes(flag)) {
        const text = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        const value = number(text, { f: 'fields to skip', s: 'bytes to skip', w: 'bytes to compare' }[flag])
        if (value === undefined) return 1
        if (flag === 'f') skipFields = value
        else if (flag === 's') skipChars = value
        else checkChars = value
        break
      } else { err(`invalid option -- '${flag}'`); err("Try 'uniq --help' for more information."); return 1 }
    }
  }

  if (operands.length > 2) { err(`extra operand '${operands[2]}'`); err("Try 'uniq --help' for more information."); return 1 }
  if (count && allRepeated) { err('printing all duplicated lines and repeat counts is meaningless'); err("Try 'uniq --help' for more information."); return 1 }

  const cwd = getcwd()
  const [input, output] = operands
  let text
  try {
    if (input === undefined || input === '-') text = decode(readFd(0))
    else {
      const fullPath = resolve(cwd, input)
      if (isDirectory(fullPath)) { err(`${input}: Is a directory`); return 1 }
      const fd = open(fullPath, O_RDONLY)
      try { text = decode(readFd(fd)) } finally { close(fd) }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    err(`${input}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
    return 1
  }

  const delimiter = zero ? '\0' : '\n'
  const lines = text === '' ? [] : text.split(delimiter)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  /** What of a line is compared: after the skipped fields and characters, up to the check length */
  const keyOf = line => {
    let at = 0
    for (let skipped = 0; skipped < skipFields; skipped++) {
      while (at < line.length && isBlank(line[at])) at++
      while (at < line.length && !isBlank(line[at])) at++
    }
    let key = line.slice(Math.min(line.length, at + skipChars))
    if (checkChars !== Infinity) key = key.slice(0, checkChars)
    return ignoreCase ? key.replace(/[a-z]/g, ch => ch.toUpperCase()) : key
  }

  // Runs of equal adjacent lines
  const groups = []
  for (const line of lines) {
    const key = keyOf(line)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.lines.push(line)
    else groups.push({ key, lines: [line] })
  }

  let out = ''
  for (const group of groups) {
    const size = group.lines.length
    if (allRepeated) {
      if (size > 1) for (const line of group.lines) out += line + delimiter
      continue
    }
    if (repeated && size < 2) continue
    if (unique && size > 1) continue
    out += (count ? String(size).padStart(7) + ' ' : '') + group.lines[0] + delimiter
  }

  const bytes = Uint8Array.from(out, ch => ch.charCodeAt(0))
  if (output === undefined || output === '-') writeAll(1, bytes)
  else {
    try {
      const fd = open(resolve(cwd, output), O_WRONLY | O_CREAT | O_TRUNC, 0o644)
      try { let at = 0; while (at < bytes.length) at += write(fd, bytes.subarray(at), -1) } finally { close(fd) }
    } catch (error) {
      err(`${output}: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
