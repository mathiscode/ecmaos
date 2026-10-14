/**
 * Wrap input lines to fit in a width, as GNU `fold` does: the text is passed through as it is (a last line with no newline stays
 * without one), a column is a character (UTF-8) with tabs going to the next multiple of 8, `-b` counts bytes instead, and `-s`
 * breaks after the last blank that fits.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`fold: ${text}\n`))

const usage = `Usage: fold [OPTION]... [FILE]...
Wrap input lines in each FILE, writing to standard output. With no FILE, or when FILE is -, read standard input.

  -b, --bytes         count bytes rather than columns
  -s, --spaces        break at spaces
  -w, --width=WIDTH   use WIDTH columns instead of 80
  --help              display this help and exit`

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
  let width = 80
  let bytesMode = false
  let spaces = false
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg === '--bytes') { bytesMode = true; continue }
    if (arg === '--spaces') { spaces = true; continue }
    const long = /^--width(?:=(.*))?$/.exec(arg)
    if (arg.startsWith('--') && !long) { err(`unrecognized option '${arg}'`); err("Try 'fold --help' for more information."); return 1 }
    // The obsolete `-5` for `-w 5`
    if (/^-\d+$/.test(arg)) { width = Number(arg.slice(1)); continue }
    if (long) {
      const text = long[1] !== undefined ? long[1] : args[++i]
      if (!/^\d+$/.test(text ?? '') || Number(text) === 0) { err(`invalid number of columns: '${text ?? ''}'`); return 1 }
      width = Number(text)
      continue
    }
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'b') bytesMode = true
      else if (flag === 's') spaces = true
      else if (flag === 'w') {
        const text = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        if (!/^\d+$/.test(text ?? '') || Number(text) === 0) { err(`invalid number of columns: '${text ?? ''}'`); return 1 }
        width = Number(text)
        break
      } else { err(`invalid option -- '${flag}'`); err("Try 'fold --help' for more information."); return 1 }
    }
  }

  /** The column after `ch` when the line is at `column` */
  const advance = (column, ch) => {
    if (bytesMode) return column + ch.length
    if (ch === '\t') return column + 8 - (column % 8)
    if (ch === '\b') return column > 0 ? column - 1 : 0
    if (ch === '\r') return 0
    return column + 1
  }

  const foldText = text => {
    let out = ''
    let line = []
    let column = 0
    // A multi-byte character is never split, even when bytes are counted
    const items = characters(text)

    const flush = () => { out += line.join(''); line = []; column = 0 }
    const recompute = () => { column = 0; for (const ch of line) column = advance(column, ch) }

    for (const ch of items) {
      if (ch === '\n') { flush(); out += '\n'; continue }
      let next = advance(column, ch)
      if (next > width && line.length) {
        if (spaces) {
          // Break after the last blank on the line, if there is one
          let at = -1
          for (let k = line.length - 1; k >= 0; k--) if (line[k] === ' ' || line[k] === '\t') { at = k; break }
          if (at >= 0) {
            out += line.slice(0, at + 1).join('') + '\n'
            line = line.slice(at + 1)
            recompute()
            next = advance(column, ch)
          } else { flush(); out += '\n'; next = advance(0, ch) }
        } else { flush(); out += '\n'; next = advance(0, ch) }
      }
      line.push(ch)
      column = next
    }
    out += line.join('')
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
        if (isDirectory(fullPath)) { err(`${file}: Is a directory`); failed = true; continue }
        const fd = open(fullPath, O_RDONLY)
        try { bytes = readFd(fd) } finally { close(fd) }
      }
      writeAll(1, encode(foldText(decode(bytes))))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
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
