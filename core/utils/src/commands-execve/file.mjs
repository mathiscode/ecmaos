/**
 * Say what kind of file something is, from its first bytes: `file photo.jpg`.
 *
 * It knows the common signatures (archives, images, documents, programs) and tells text from data, which is
 * what most uses need; it is not the full magic database.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, lstat, readlink, open, close, read, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`file: ${text}\n`))
const S_IFMT = 0xf000

const usage = `Usage: file [OPTION]... FILE...
Determine the type of each FILE.

  -b, --brief      do not prefix lines with the file name
  -i, --mime       print the MIME type (and charset for text)
  --mime-type      print only the MIME type
  --help           display this help and exit`

const startsWith = (bytes, ...codes) => codes.every((code, index) => bytes[index] === code)
const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to))

/** `[description, mime]` for the bytes of a file. */
function identify(bytes) {
  if (bytes.length === 0) return ['empty', 'inode/x-empty']
  if (startsWith(bytes, 0x1f, 0x8b)) return ['gzip compressed data', 'application/gzip']
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) return ['Zip archive data', 'application/zip']
  if (startsWith(bytes, 0x50, 0x4b, 0x05, 0x06)) return ['Zip archive data (empty)', 'application/zip']
  if (startsWith(bytes, 0x42, 0x5a, 0x68)) return ['bzip2 compressed data', 'application/x-bzip2']
  if (startsWith(bytes, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return ['XZ compressed data', 'application/x-xz']
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return [bytes.length >= 24 ? `PNG image data, ${view.getUint32(16)} x ${view.getUint32(20)}` : 'PNG image data', 'image/png']
  }
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return ['JPEG image data', 'image/jpeg']
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return [`GIF image data, version ${ascii(bytes, 3, 6)}`, 'image/gif']
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return ['Web/P image', 'image/webp']
  if (ascii(bytes, 0, 5) === '%PDF-') return [`PDF document, version ${ascii(bytes, 5, 8)}`, 'application/pdf']
  if (startsWith(bytes, 0x00, 0x61, 0x73, 0x6d)) return ['WebAssembly (wasm) binary module', 'application/wasm']
  if (startsWith(bytes, 0x7f, 0x45, 0x4c, 0x46)) return ['ELF executable', 'application/x-executable']
  if (bytes.length > 262 && ascii(bytes, 257, 262) === 'ustar') return ['POSIX tar archive', 'application/x-tar']
  if (ascii(bytes, 0, 4) === 'OggS') return ['Ogg data', 'application/ogg']
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return ['MPEG audio', 'audio/mpeg']
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return ['RIFF (little-endian) data, WAVE audio', 'audio/x-wav']
  if (ascii(bytes, 0, 15) === 'SQLite format 3') return ['SQLite 3.x database', 'application/vnd.sqlite3']

  // text: no NUL and no control characters other than the usual whitespace, and valid UTF-8 if not ASCII
  let isAscii = true
  for (const byte of bytes.subarray(0, 8192)) {
    if (byte === 0 || (byte < 32 && ![9, 10, 12, 13, 27].includes(byte))) return ['data', 'application/octet-stream']
    if (byte > 127) isAscii = false
  }
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 65536)) } catch { return ['data', 'application/octet-stream'] }
  const kind = isAscii ? 'ASCII text' : 'Unicode text, UTF-8 text'
  const crlf = /\r\n/.test(text) ? ', with CRLF line terminators' : ''
  const noEol = text.length > 0 && !text.endsWith('\n') ? ', with no line terminators' : ''
  const charset = isAscii ? 'us-ascii' : 'utf-8'
  if (text.startsWith('#!')) {
    const line = text.split('\n')[0].slice(2).trim()
    const interpreter = line.split(/\s+/)[0] === '/usr/bin/env' ? line.split(/\s+/)[1] : line.split(/\s+/)[0].split('/').pop()
    return [`${interpreter === 'sh' || interpreter === 'bash' || interpreter === 'ecmash' ? 'Bourne-Again shell' : interpreter} script, ${kind} executable${crlf}${noEol}`, 'text/x-shellscript;charset=' + charset]
  }
  const trimmed = text.trimStart()
  if (/^<\?xml/i.test(trimmed)) return [`XML document text${crlf}`, 'text/xml;charset=' + charset]
  if (/^<!doctype html|^<html/i.test(trimmed)) return [`HTML document, ${kind}${crlf}${noEol}`, 'text/html;charset=' + charset]
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(text); return [`JSON text data`, 'application/json;charset=' + charset] } catch { /* not JSON */ }
  }
  return [`${kind}${crlf}${noEol}`, 'text/plain;charset=' + charset]
}

function main() {
  const args = argv.slice(1)
  let brief = false
  let mime = false
  let mimeOnly = false
  const files = []
  for (const arg of args) {
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--brief') brief = true
    else if (arg === '--mime') mime = true
    else if (arg === '--mime-type') { mime = true; mimeOnly = true }
    else if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); return 1 }
    else if (/^-[bi]+$/.test(arg)) { if (arg.includes('b')) brief = true; if (arg.includes('i')) mime = true }
    else files.push(arg)
  }
  if (files.length === 0) { err('missing file operand'); return 1 }
  const cwd = getcwd()
  const width = brief ? 0 : Math.max(...files.map(file => file.length)) + 1
  let status = 0
  for (const file of files) {
    let description
    let mimeType
    try {
      const path = resolve(cwd, file)
      const info = lstat(path)
      const type = info.mode & S_IFMT
      if (type === 0x4000) { description = 'directory'; mimeType = 'inode/directory' }
      else if (type === 0xa000) { description = `symbolic link to ${readlink(path)}`; mimeType = 'inode/symlink' }
      else if (type === 0x2000 || type === 0x6000) { description = type === 0x2000 ? 'character special' : 'block special'; mimeType = type === 0x2000 ? 'inode/chardevice' : 'inode/blockdevice' }
      else if (type === 0x1000) { description = 'fifo (named pipe)'; mimeType = 'inode/fifo' }
      else {
        const fd = open(path, O_RDONLY, 0)
        try {
          const head = new Uint8Array(65536)
          const n = read(fd, head, -1)
          ;[description, mimeType] = identify(head.subarray(0, Math.max(0, n)))
        } finally { close(fd) }
      }
    } catch (error) {
      description = `cannot open (${error?.message ?? error})`
      mimeType = 'application/octet-stream'
      status = 1
    }
    const shown = mime ? (mimeOnly ? mimeType.split(';')[0] : mimeType) : description
    writeAll(1, encoder.encode(brief ? shown + '\n' : `${(file + ':').padEnd(width + 1)}${shown}\n`))
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
