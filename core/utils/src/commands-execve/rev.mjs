/** Reverse the characters of each line, as `rev` does: UTF-8 characters stay whole, and a last line with no newline stays without one. */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`rev: ${text}\n`))

const usage = `Usage: rev [options] [file ...]
Reverse lines characterwise. With no file, or when file is -, read standard input.

  -0, --zero   use the NUL byte as line separator
  -h, --help   display this help and exit`

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

/** A string of one character per byte as its UTF-8 characters, each still made of bytes */
function characters(text) {
  const out = []
  for (let i = 0; i < text.length;) {
    const byte = text.charCodeAt(i)
    const length = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc2 && byte < 0xe0 ? 2 : 1
    let ok = length > 1 && i + length <= text.length
    for (let k = 1; ok && k < length; k++) if ((text.charCodeAt(i + k) & 0xc0) !== 0x80) ok = false
    const size = ok ? length : 1
    out.push(text.slice(i, i + size))
    i += size
  }
  return out
}

function main() {
  const args = argv.slice(1)
  let delimiter = '\n'
  const files = []
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-0' || arg === '--zero') delimiter = '\0'
    else if (arg !== '-' && arg.startsWith('-')) { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); err("Try 'rev --help' for more information."); return 1 }
    else files.push(arg)
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
        if (isDirectory(fullPath)) { err(`${file}: Is a directory`); failed = true; continue }
        const fd = open(fullPath, O_RDONLY)
        try { bytes = readFd(fd) } finally { close(fd) }
      }
      const text = decode(bytes)
      const out = text.split(delimiter).map(line => characters(line).reverse().join('')).join(delimiter)
      writeAll(1, Uint8Array.from(out, ch => ch.charCodeAt(0)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`cannot open ${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
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
