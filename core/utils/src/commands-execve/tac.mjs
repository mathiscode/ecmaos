/**
 * Write each file with its records in reverse order, as GNU `tac` does. A record ends with its separator (a newline, or `-s`),
 * which stays attached, so a last line with no newline is printed first and joins the line before it. `-b` attaches the separator
 * before the record, and `-r` takes the separator as a regular expression.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`tac: ${text}\n`))

const usage = `Usage: tac [OPTION]... [FILE]...
Write each FILE to standard output, last line first. With no FILE, or when FILE is -, read standard input.

  -b, --before             attach the separator before instead of after
  -r, --regex              interpret the separator as a regular expression
  -s, --separator=STRING   use STRING as the separator instead of newline
  --help                   display this help and exit`

const decode = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }
const encode = text => Uint8Array.from(text, ch => ch.charCodeAt(0))

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
  let before = false
  let regex = false
  let separator = '\n'
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg === '--before') { before = true; continue }
    if (arg === '--regex') { regex = true; continue }
    const long = /^--separator(?:=(.*))?$/.exec(arg)
    if (long) { separator = long[1] !== undefined ? long[1] : args[++i]; continue }
    if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'tac --help' for more information."); return 1 }
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'b') before = true
      else if (flag === 'r') regex = true
      else if (flag === 's') {
        separator = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        break
      } else { err(`invalid option -- '${flag}'`); err("Try 'tac --help' for more information."); return 1 }
    }
  }
  if (separator === undefined || separator === '') { err('separator cannot be empty'); return 1 }

  const matcher = regex ? new RegExp(separator, 'g') : undefined

  /** The text cut into records, each with its separator, in order */
  const records = text => {
    const marks = []
    if (matcher) {
      matcher.lastIndex = 0
      for (let m = matcher.exec(text); m; m = matcher.exec(text)) {
        if (m[0] === '') { matcher.lastIndex++; continue }
        marks.push([m.index, m.index + m[0].length])
      }
    } else {
      for (let at = text.indexOf(separator); at >= 0; at = text.indexOf(separator, at + separator.length)) marks.push([at, at + separator.length])
    }
    const out = []
    if (before) {
      // Each record starts with its separator; what comes before the first one is a record of its own
      if (marks.length === 0) return text ? [text] : []
      if (marks[0][0] > 0) out.push(text.slice(0, marks[0][0]))
      marks.forEach(([start], index) => out.push(text.slice(start, index + 1 < marks.length ? marks[index + 1][0] : text.length)))
      return out
    }
    let from = 0
    for (const [, end] of marks) { out.push(text.slice(from, end)); from = end }
    if (from < text.length) out.push(text.slice(from))
    return out
  }

  const cwd = getcwd()
  let failed = false
  if (files.length === 0) files.push('-')
  for (const file of files) {
    try {
      let bytes
      if (file === '-') bytes = readFd(0)
      else {
        const fullPath = resolve(cwd, file)
        if (isDirectory(fullPath)) { err(`${file}: read error: Is a directory`); failed = true; continue }
        const fd = open(fullPath, O_RDONLY)
        try { bytes = readFd(fd) } finally { close(fd) }
      }
      writeAll(1, encode(records(decode(bytes)).reverse().join('')))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`failed to open '${file}' for reading: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      failed = true
    }
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
