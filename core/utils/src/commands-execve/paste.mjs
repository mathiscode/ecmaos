/**
 * Merge corresponding lines of files side by side, as GNU `paste` does: line N of each file on one line, separated by tabs or
 * by the characters of `-d` used in turn. `-s` pastes one file at a time, and each `-` takes the next line of standard input, so
 * `paste - - < file` pairs lines. `-z` takes NUL-terminated lines.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`paste: ${text}\n`))

const usage = `Usage: paste [OPTION]... [FILE]...
Write lines consisting of the sequentially corresponding lines from each FILE, separated by TABs, to standard output.
With no FILE, or when FILE is -, read standard input.

  -d, --delimiters=LIST   reuse characters from LIST instead of TABs
  -s, --serial            paste one file at a time instead of in parallel
  -z, --zero-terminated   line delimiter is NUL, not newline
  --help                  display this help and exit`

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

/** The characters of a `-d` list, with `\n`, `\t`, `\\` and `\0` (an empty delimiter) */
function delimiters(list) {
  const out = []
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '\\' && i + 1 < list.length) {
      const next = list[++i]
      out.push(next === 'n' ? '\n' : next === 't' ? '\t' : next === '0' ? '' : next === '\\' ? '\\' : next)
    } else out.push(list[i])
  }
  return out.length ? out : ['']
}

function main() {
  const args = argv.slice(1)
  let list = ['\t']
  let serial = false
  let zero = false
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg === '--serial') { serial = true; continue }
    if (arg === '--zero-terminated') { zero = true; continue }
    const long = /^--delimiters(?:=(.*))?$/.exec(arg)
    if (long) { list = delimiters(long[1] !== undefined ? long[1] : args[++i] ?? ''); continue }
    if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'paste --help' for more information."); return 1 }
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 's') serial = true
      else if (flag === 'z') zero = true
      else if (flag === 'd') { list = delimiters(c + 1 < arg.length ? arg.slice(c + 1) : args[++i] ?? ''); break }
      else { err(`invalid option -- '${flag}'`); err("Try 'paste --help' for more information."); return 1 }
    }
  }

  const end = zero ? '\0' : '\n'
  const cwd = getcwd()
  if (files.length === 0) files.push('-')

  // Standard input is read once and its lines are shared out among the `-` operands
  let stdinLines
  const takeStdin = () => {
    if (!stdinLines) {
      const text = decode(readFd(0))
      stdinLines = text === '' ? [] : text.split(end)
      if (stdinLines.length && stdinLines[stdinLines.length - 1] === '') stdinLines.pop()
      stdinLines.reverse()
    }
    return stdinLines
  }

  let failed = false
  /** Each operand as a source of lines; `next()` gives the next line or `undefined` */
  const sources = []
  for (const file of files) {
    if (file === '-') {
      sources.push({ next: () => takeStdin().pop(), all: () => { const rest = takeStdin().reverse(); stdinLines = []; return rest } })
      continue
    }
    try {
      const fullPath = resolve(cwd, file)
      if (isDirectory(fullPath)) { err(`${file}: Is a directory`); failed = true; continue }
      const fd = open(fullPath, O_RDONLY)
      let text
      try { text = decode(readFd(fd)) } finally { close(fd) }
      const lines = text === '' ? [] : text.split(end)
      if (lines.length && lines[lines.length - 1] === '') lines.pop()
      let at = 0
      sources.push({ next: () => (at < lines.length ? lines[at++] : undefined), all: () => lines.slice(at) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      failed = true
    }
  }

  let out = ''
  if (serial) {
    for (const source of sources) {
      const lines = source.all()
      let line = ''
      lines.forEach((text, index) => { line += (index ? list[(index - 1) % list.length] : '') + text })
      out += line + end
    }
  } else if (sources.length) {
    for (;;) {
      const parts = sources.map(source => source.next())
      if (parts.every(part => part === undefined)) break
      let line = ''
      parts.forEach((part, index) => { line += (index ? list[(index - 1) % list.length] : '') + (part ?? '') })
      out += line + end
    }
  }
  writeAll(1, Uint8Array.from(out, ch => ch.charCodeAt(0)))
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
