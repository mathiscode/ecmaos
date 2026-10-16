/**
 * Dump files in octal and other formats, as GNU `od` does: offsets in octal (`-A`), 16 bytes a line (`-w`), one or more output
 * types (`-t a c d f o u x`, with a size, and the shorthands `-a -b -c -d -f -i -l -o -s -x`), `-j` to skip and `-N` to stop,
 * and a `*` in place of lines that repeat the one before (unless `-v`). Without `-t` the type is `o2`. Numbers are little endian,
 * and a last element that runs out of bytes is padded with zeros.
 */

import { resolve } from './lib/path-utils.mjs'
import { formatPrintf } from '../lib/printf-format.ts'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`od: ${text}\n`))

const usage = `Usage: od [OPTION]... [FILE]...
Write an unambiguous representation, octal bytes by default, of FILE to standard output. With no FILE, or when FILE is -, read standard input.

  -A, --address-radix=RADIX   output format for file offsets; RADIX is one of [doxn], for Decimal, Octal, Hex or None
  -j, --skip-bytes=BYTES      skip BYTES input bytes first
  -N, --read-bytes=BYTES      limit dump to BYTES input bytes
  -t, --format=TYPE           select output format or formats
  -v, --output-duplicates     do not use * to mark line suppression
  -w[BYTES], --width[=BYTES]  output BYTES bytes per output line; 32 is implied when BYTES is not specified

Output format shorthands: -a (-t a), -b (-t o1), -c (-t c), -d (-t u2), -f (-t fF), -i (-t dI), -l (-t dL), -o (-t o2), -s (-t d2), -x (-t x2).

TYPE is made up of one or more of these specifications: a (named character, ignoring high-order bit), c (printable character or backslash escape), d[SIZE] (signed decimal), f[SIZE] (floating point), o[SIZE] (octal), u[SIZE] (unsigned decimal), x[SIZE] (hexadecimal). SIZE is a number; for d, o, u and x it may be C, S, I or L (char, short, int, long), for f it may be F, D or L (float, double, long double).`

const names = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si', 'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp']
const escapes = { 0: '\\0', 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' }
const sizeLetters = { C: 1, S: 2, I: 4, L: 8 }
const floatSizes = { F: 4, D: 8, L: 8 }

/** `a`, `c`, `x2`, `dI`, `fF` ... as `{ kind, size, width }`, or an error text */
function parseType(text) {
  const match = /^([acdfoux])([A-Za-z]|\d+)?$/.exec(text)
  if (!match) return { error: `invalid type string '${text}'` }
  const kind = match[1]
  if (kind === 'a' || kind === 'c') return match[2] ? { error: `invalid type string '${text}'` } : { kind, size: 1, width: 3 }
  let size = match[2] === undefined ? (kind === 'f' ? 8 : 2) : /^\d+$/.test(match[2]) ? Number(match[2]) : (kind === 'f' ? floatSizes[match[2]] : sizeLetters[match[2]])
  if (kind === 'f') { if (size !== 4 && size !== 8) return { error: `invalid type string '${text}'` } }
  else if (![1, 2, 4, 8].includes(size)) return { error: `invalid type string '${text}'` }
  // A bare d, o, u or x is the size of an int
  if (match[2] === undefined && kind !== 'f') size = 4
  const widths = {
    o: { 1: 3, 2: 6, 4: 11, 8: 22 }, x: { 1: 2, 2: 4, 4: 8, 8: 16 }, u: { 1: 3, 2: 5, 4: 10, 8: 20 }, d: { 1: 4, 2: 6, 4: 11, 8: 20 }, f: { 4: 15, 8: 24 }
  }
  return { kind, size, width: widths[kind][size] }
}

function elementText(type, bytes) {
  if (type.kind === 'a') { const b = bytes[0] & 0x7f; return b <= 32 ? names[b] : b === 127 ? 'del' : String.fromCharCode(b) }
  if (type.kind === 'c') { const b = bytes[0]; return b in escapes ? escapes[b] : b >= 32 && b < 127 ? String.fromCharCode(b) : b.toString(8).padStart(3, '0') }
  const view = new DataView(bytes.buffer, bytes.byteOffset, type.size)
  if (type.kind === 'f') {
    const value = type.size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true)
    return formatPrintf(type.size === 4 ? '%.9g' : '%.17g', [String(value)])
  }
  let unsigned = 0n
  for (let k = type.size - 1; k >= 0; k--) unsigned = (unsigned << 8n) | BigInt(bytes[k])
  if (type.kind === 'd') return BigInt.asIntN(type.size * 8, unsigned).toString()
  if (type.kind === 'o') return unsigned.toString(8).padStart(type.width, '0')
  if (type.kind === 'x') return unsigned.toString(16).padStart(type.size * 2, '0')
  return unsigned.toString()
}

function main() {
  const args = argv.slice(1)
  let radix = 'o'
  let skip = 0
  let limit = Infinity
  let width
  let duplicates = false
  const types = []
  const files = []

  const number = (text, what) => {
    const match = /^(0[xX][0-9a-fA-F]+|\d+)(b|k|KB|kB|K|MB|M|GB|G)?$/.exec(text ?? '')
    if (!match) { err(`invalid ${what} argument '${text ?? ''}'`); return undefined }
    const base = /^0[xX]/.test(match[1]) ? parseInt(match[1], 16) : /^0\d/.test(match[1]) ? parseInt(match[1], 8) : Number(match[1])
    return base * ({ undefined: 1, b: 512, k: 1024, K: 1024, kB: 1000, KB: 1000, M: 1048576, MB: 1e6, G: 2 ** 30, GB: 1e9 }[match[2]])
  }
  const addType = text => {
    for (let at = 0; at < text.length;) {
      const m = /^([acdfoux])([A-Za-z]|\d+)?/.exec(text.slice(at))
      if (!m) { err(`invalid type string '${text.slice(at)}'`); return false }
      const type = parseType(m[0])
      if (type.error) { err(type.error); return false }
      types.push(type)
      at += m[0].length
    }
    return true
  }
  const shorthand = { a: 'a', b: 'o1', c: 'c', d: 'u2', f: 'fF', i: 'dI', l: 'dL', o: 'o2', s: 'd2', x: 'x2' }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg === '--output-duplicates') { duplicates = true; continue }
    const long = /^--(address-radix|skip-bytes|read-bytes|format|width)(?:=(.*))?$/.exec(arg)
    if (long) {
      const value = long[2] !== undefined ? long[2] : long[1] === 'width' ? undefined : args[++i]
      if (long[1] === 'address-radix') { if (!/^[doxn]$/.test(value ?? '')) { err(`invalid output address radix '${value}'; it must be one character from [doxn]`); return 1 } radix = value }
      else if (long[1] === 'skip-bytes') { skip = number(value, '--skip-bytes'); if (skip === undefined) return 1 }
      else if (long[1] === 'read-bytes') { limit = number(value, '--read-bytes'); if (limit === undefined) return 1 }
      else if (long[1] === 'format') { if (!addType(value ?? '')) return 1 }
      else width = value === undefined ? 32 : number(value, '--width')
      continue
    }
    if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'od --help' for more information."); return 1 }
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'v') duplicates = true
      else if (flag in shorthand) addType(shorthand[flag])
      else if ('AjNt'.includes(flag)) {
        const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        if (flag === 'A') { if (!/^[doxn]$/.test(value ?? '')) { err(`invalid output address radix '${value}'; it must be one character from [doxn]`); return 1 } radix = value }
        else if (flag === 'j') { skip = number(value, '--skip-bytes'); if (skip === undefined) return 1 }
        else if (flag === 'N') { limit = number(value, '--read-bytes'); if (limit === undefined) return 1 }
        else if (!addType(value ?? '')) return 1
        break
      } else if (flag === 'w') {
        const value = arg.slice(c + 1)
        width = value === '' ? 32 : number(value, '--width')
        if (width === undefined) return 1
        break
      } else { err(`invalid option -- '${flag}'`); err("Try 'od --help' for more information."); return 1 }
    }
  }

  if (types.length === 0) types.push(parseType('o2'))
  // The bytes on a line are a multiple of the largest element, 16 by default
  const largest = Math.max(...types.map(type => type.size))
  const lineBytes = width ?? Math.max(16, largest)
  if (lineBytes % largest !== 0) { err(`warning: invalid width ${lineBytes}; using ${largest} instead`) }
  const perLine = lineBytes % largest === 0 ? lineBytes : largest

  // Read only as much as is wanted: the skip and the limit
  const wanted = limit === Infinity ? Infinity : skip + limit
  const cwd = getcwd()
  if (files.length === 0) files.push('-')
  const chunks = []
  let total = 0
  let failed = false
  const take = fd => {
    while (total < wanted) {
      const buffer = new Uint8Array(Math.min(65536, wanted - total))
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      total += n
    }
  }
  for (const file of files) {
    if (total >= wanted) break
    try {
      if (file === '-') { take(0); continue }
      const fullPath = resolve(cwd, file)
      if (isDirectory(fullPath)) { err(`${file}: read error: Is a directory`); failed = true; continue }
      const fd = open(fullPath, O_RDONLY)
      try { take(fd) } finally { close(fd) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      failed = true
    }
  }
  let all = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length }
  all = all.subarray(Math.min(skip, all.length), limit === Infinity ? all.length : Math.min(skip + limit, all.length))

  const offsetText = value => (radix === 'n' ? '' : radix === 'd' ? String(value).padStart(7, '0') : radix === 'x' ? value.toString(16).padStart(6, '0') : value.toString(8).padStart(7, '0'))
  const blankOffset = ' '.repeat(offsetText(0).length)

  let out = ''
  let previous
  let suppressing = false
  for (let start = 0; start < all.length; start += perLine) {
    const line = all.subarray(start, Math.min(all.length, start + perLine))
    const full = line.length === perLine
    if (!duplicates && full && previous && previous.length === line.length && previous.every((b, k) => b === line[k])) {
      if (!suppressing) { out += '*\n'; suppressing = true }
      continue
    }
    suppressing = false
    previous = full ? line : undefined
    types.forEach((type, row) => {
      let text = row === 0 ? offsetText(skip + start) : blankOffset
      for (let element = 0; element * type.size < line.length; element++) {
        const bytes = new Uint8Array(type.size)
        bytes.set(line.subarray(element * type.size, (element + 1) * type.size))
        text += ' ' + elementText(type, bytes).padStart(type.width)
      }
      out += text + '\n'
    })
  }
  if (radix !== 'n') out += offsetText(skip + all.length) + '\n'
  writeAll(1, encoder.encode(out))
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
