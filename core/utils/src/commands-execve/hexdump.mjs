/**
 * `hexdump`: display file contents in hexadecimal, decimal, octal or ASCII, as util-linux's hexdump does. The predefined layouts
 * (`-b -c -C -d -o -x`, and the default) and `-e` format strings go through the same engine: a format is units like
 * `16/1 "%02x "`, repeated over blocks of the input, with a `*` where a block repeats the one before, and blanks where the input
 * runs out. `-s` skips, `-n` limits, `-v` shows every line.
 */

import { readFdBytes, readFileBytes, writeFdBytes } from './lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { resolve } from './lib/path-utils.mjs'
import { formatPrintf } from '../lib/printf-format.ts'

const { argv, exit, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeFdBytes(2, encoder.encode(`hexdump: ${text}\n`))

const usage = `
Usage:
 hexdump [options] <file>...

Display file contents in hexadecimal, decimal, octal, or ascii.

Options:
 -b, --one-byte-octal      one-byte octal display
 -c, --one-byte-char       one-byte character display
 -C, --canonical           canonical hex+ASCII display
 -d, --two-bytes-decimal   two-byte decimal display
 -o, --two-bytes-octal     two-byte octal display
 -x, --two-bytes-hex       two-byte hexadecimal display
 -L, --color[=<mode>]      interpret color formatting specifiers
                             colors are enabled by default

 -e, --format <format>     format string to be used for displaying data
 -f, --format-file <file>  file that contains format strings
 -n, --length <length>     interpret only length bytes of input
 -s, --skip <offset>       skip offset bytes from the beginning
 -v, --no-squeezing        output identical lines

 -h, --help                display this help
 -V, --version             display version

For more details see hexdump(1).
`

/** A string as the byte characters of its UTF-8, since the output is built a byte to a character */
const asBytes = text => Array.from(encoder.encode(text), b => String.fromCharCode(b)).join('')

const NAMES = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', ' bs', ' ht', ' lf', ' vt', ' ff', ' cr', ' so', ' si', 'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', ' em', 'sub', 'esc', ' fs', ' gs', ' rs', ' us']
const ESCAPES = { 0: '\\0', 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' }

class FormatError extends Error {}

/** One conversion of a unit: `{ kind, spec, size }`, or text `{ text }` */
function parseUnitFormat(text, explicitBytes) {
  const pieces = []
  let literal = ''
  let first = true
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '%') { literal += ch; continue }
    if (text[i + 1] === '%') { literal += '%'; i++; continue }
    const match = /^%([-+ #0]*)(\d*)(?:\.(\d+))?(?:_([aAcpu])([dox])?|([diouxXeEfgGcs]))/.exec(text.slice(i))
    if (!match) throw new FormatError(`bad conversion character ${text.slice(i, i + 2)}`)
    if (literal) { pieces.push({ text: literal }); literal = '' }
    const [whole, flags, width, precision, special, radix, plain] = match
    let kind = special ? `_${special}` : plain
    let size
    if (special === 'a' || special === 'A') size = 0
    else if (special) size = 1
    else if ('diouxX'.includes(plain)) size = 4
    else if ('eEfgG'.includes(plain)) size = 8
    else if (plain === 'c') size = 1
    else size = 0
    if (first && explicitBytes !== undefined && size !== 0) size = explicitBytes
    else if (first && explicitBytes !== undefined && plain === 's') size = explicitBytes
    if (plain === 's' && size === 0) throw new FormatError('%s requires a precision or a byte count')
    if (!special && 'diouxX'.includes(plain) && ![1, 2, 4, 8].includes(size)) throw new FormatError(`bad byte count for conversion character ${plain}`)
    if (!special && 'eEfgG'.includes(plain) && ![4, 8].includes(size)) throw new FormatError(`floating point numbers require a 4 or 8 byte count`)
    pieces.push({ kind, flags, width: width ? Number(width) : undefined, precision: precision === undefined ? undefined : Number(precision), radix: radix ?? 'x', conversion: plain, size })
    first = false
    i += whole.length - 1
  }
  if (literal) pieces.push({ text: literal })
  return pieces
}

/** `{ units, size }` of one format string; a unit is `{ reps, pieces, bytes }` */
function parseFormat(text) {
  const units = []
  let i = 0
  const n = text.length
  while (i < n) {
    if (/\s/.test(text[i])) { i++; continue }
    let reps = 1
    let bytes
    const prefix = /^(\d+)?(?:\/(\d+))?/.exec(text.slice(i))
    if (prefix[0] && text[i + prefix[0].length] !== '"' && !/\s/.test(text[i + prefix[0].length] ?? '')) throw new FormatError(`bad format {${text}}`)
    if (prefix[0]) { if (prefix[1]) reps = Number(prefix[1]); if (prefix[2]) bytes = Number(prefix[2]); i += prefix[0].length }
    while (/\s/.test(text[i] ?? '')) i++
    if (text[i] !== '"') throw new FormatError(`bad format {${text}}`)
    i++
    let body = ''
    for (;;) {
      if (i >= n) throw new FormatError(`bad format {${text}}`)
      const ch = text[i++]
      if (ch === '"') break
      if (ch === '\\') {
        const next = text[i++]
        const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '"': '"', '\\': '\\', 0: '\0' }
        body += next in map ? map[next] : '\\' + next
        continue
      }
      body += ch
    }
    const pieces = parseUnitFormat(body, bytes)
    const unitBytes = pieces.reduce((sum, piece) => sum + (piece.size ?? 0), 0)
    units.push({ reps, pieces, bytes: unitBytes })
  }
  const size = units.reduce((sum, unit) => sum + unit.reps * unit.bytes, 0)
  return { units, size }
}

const PREDEFINED = {
  default: ['"%07.7_Ax\\n"', '"%07.7_ax " 8/2 "%04x " "\\n"'],
  b: ['"%07.7_Ax\\n"', '"%07.7_ax " 16/1 "%03o " "\\n"'],
  c: ['"%07.7_Ax\\n"', '"%07.7_ax " 16/1 "%3_c " "\\n"'],
  C: ['"%08.8_Ax\\n"', '"%08.8_ax  " 8/1 "%02x " "  " 8/1 "%02x "', '"  |" 16/1 "%_p" "|\\n"'],
  d: ['"%07.7_Ax\\n"', '"%07.7_ax " 8/2 "  %05u " "\\n"'],
  o: ['"%07.7_Ax\\n"', '"%07.7_ax " 8/2 " %06o " "\\n"'],
  x: ['"%07.7_Ax\\n"', '"%07.7_ax " 8/2 "   %04x " "\\n"']
}

function readValue(block, at, size, signed, float) {
  const view = new DataView(block.buffer, block.byteOffset, block.length)
  if (float) return size === 4 ? view.getFloat32(at, true) : view.getFloat64(at, true)
  if (size === 1) return signed ? view.getInt8(at) : view.getUint8(at)
  if (size === 2) return signed ? view.getInt16(at, true) : view.getUint16(at, true)
  if (size === 4) return signed ? view.getInt32(at, true) : view.getUint32(at, true)
  return signed ? view.getBigInt64(at, true) : view.getBigUint64(at, true)
}

/** Text for one conversion applied to `block` at `at`; with `blank` the conversion shows as spaces of the same width */
function render(piece, block, at, address, blank, endAddress) {
  const { kind, flags, width, precision } = piece
  const spec = `%${flags}${width ?? ''}${precision !== undefined ? '.' + precision : ''}`
  let text
  const padText = value => (width !== undefined ? (flags.includes('-') ? value.padEnd(width) : value.padStart(width)) : value)
  if (kind === '_a' || kind === '_A') {
    const value = kind === '_A' ? endAddress : address
    return formatPrintf(`${spec}${piece.radix === 'd' ? 'd' : piece.radix === 'o' ? 'o' : 'x'}`, [String(value)])
  }
  if (blank) {
    // the width the conversion would have taken
    let sample
    if (kind === '_c') sample = padText('x')
    else if (kind === '_p') return ''
    else if (kind === '_u') sample = padText('nul')
    else if (piece.conversion === 'c') sample = padText('x')
    else if (piece.conversion === 's') sample = padText(' '.repeat(piece.size))
    else sample = formatPrintf(`${spec}${piece.conversion}`, ['0'])
    return ' '.repeat(sample.length)
  }
  if (kind === '_c') {
    const byte = block[at]
    text = byte in ESCAPES ? ESCAPES[byte] : byte >= 32 && byte < 127 ? String.fromCharCode(byte) : byte.toString(8).padStart(3, '0')
    return padText(text)
  }
  if (kind === '_u') { const byte = block[at]; return padText(byte < 32 ? NAMES[byte] : byte === 127 ? 'del' : String.fromCharCode(byte)) }
  if (piece.conversion === 'c') return padText(String.fromCharCode(block[at]))
  if (piece.conversion === 's') return padText(Array.from(block.subarray(at, at + piece.size), b => String.fromCharCode(b)).join('').replace(/\0.*$/s, '').slice(0, precision ?? Infinity))
  const float = 'eEfgG'.includes(piece.conversion)
  const signed = 'di'.includes(piece.conversion)
  const value = readValue(block, at, piece.size, signed, float)
  return formatPrintf(`${spec}${piece.conversion}`, [String(value)])
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'bcCdoxe:f:n:s:vLhV',
    long: { 'one-byte-octal': 'b', 'one-byte-char': 'c', canonical: 'C', 'two-bytes-decimal': 'd', 'two-bytes-octal': 'o', 'two-bytes-hex': 'x', format: { key: 'e', arg: 'required' }, 'format-file': { key: 'f', arg: 'required' }, length: { key: 'n', arg: 'required' }, skip: { key: 's', arg: 'required' }, 'no-squeezing': 'v', color: { key: 'L', arg: 'optional' }, help: 'h', version: 'V' }
  })
  if (error) { err(error); writeFdBytes(2, encoder.encode("Try 'hexdump --help' for more information.\n")); return 1 }
  const formats = []
  let skip = 0
  let length
  let squeeze = true
  const number = (text, what) => {
    const match = /^(\d+)(b|k|kb|m|mb)?$/i.exec(text) ?? /^0x([0-9a-f]+)$/i.exec(text)
    if (!match) throw new FormatError(`invalid ${what} argument: ‘${text}’`)
    if (/^0x/i.test(text)) return parseInt(match[1], 16)
    const unit = { b: 512, k: 1024, kb: 1000, m: 1048576, mb: 1e6 }[(match[2] ?? '').toLowerCase()] ?? 1
    return Number(match[1]) * unit
  }
  try {
    for (const [key, value] of options) {
      if (key === 'h') { writeFdBytes(1, encoder.encode(usage)); return 0 }
      if (key === 'V') { writeFdBytes(1, encoder.encode('hexdump from util-linux (ecmaOS)\n')); return 0 }
      if ('bcCdox'.includes(key)) formats.push(...PREDEFINED[key])
      else if (key === 'e') formats.push(value)
      else if (key === 'f') {
        let bytes
        try { bytes = readFileBytes(resolve(getcwd(), value)) } catch (e) { throw new FormatError(`${value}: ${reasonOf(e)}`) }
        for (const line of new TextDecoder().decode(bytes).split('\n')) if (line.trim() && !line.trim().startsWith('#')) formats.push(line)
      } else if (key === 'n') length = number(value, 'length')
      else if (key === 's') skip = number(value, 'skip')
      else if (key === 'v') squeeze = false
    }
    if (formats.length === 0) formats.push(...PREDEFINED.default)
    const parsed = formats.map(parseFormat)
    const blockSize = Math.max(...parsed.map(fs => fs.size))
    if (blockSize === 0) throw new FormatError('bad format: no data would be consumed')
    return run(parsed, blockSize, operands, { skip, length, squeeze })
  } catch (error) {
    if (error instanceof FormatError) { err(error.message); return 1 }
    throw error
  }
}

function run(formats, blockSize, files, { skip, length, squeeze }) {
  const cwd = getcwd()
  const chunks = []
  let failed = 0
  const names = files.length ? files : ['-']
  for (const name of names) {
    try { chunks.push(files.length === 0 ? readFdBytes(0) : readFileBytes(resolve(cwd, name))) } catch (e) { err(`${name}: ${reasonOf(e)}`); failed++ }
  }
  if (failed === names.length) { err('all input file arguments failed'); return 1 }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  let data = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { data.set(chunk, at); at += chunk.length }
  const startAddress = Math.min(skip, data.length)
  data = data.subarray(startAddress)
  if (length !== undefined) data = data.subarray(0, length)
  const endAddress = startAddress + data.length
  let out = ''
  let previous
  let suppressing = false
  const atEnd = formats.filter(fs => fs.units.some(unit => unit.pieces.some(piece => piece.kind === '_A')))
  for (let start = 0; start < data.length; start += blockSize) {
    const nread = Math.min(blockSize, data.length - start)
    const block = new Uint8Array(blockSize)
    block.set(data.subarray(start, start + nread))
    if (squeeze && previous && nread === blockSize && previous.every((b, i) => b === block[i])) {
      if (!suppressing) { out += '*\n'; suppressing = true }
      continue
    }
    suppressing = false
    previous = nread === blockSize ? block : undefined
    const address = startAddress + start
    for (const fs of formats) {
      if (atEnd.includes(fs)) continue
      let position = 0
      for (const unit of fs.units) {
        // a unit of one single-character conversion shrinks at the end of the data instead of showing blanks
        const shrinks = unit.reps > 1 && unit.pieces.some(piece => piece.kind === '_p') && unit.pieces.filter(piece => piece.size).length === 1
        let reps = unit.reps
        if (shrinks) reps = Math.max(0, Math.min(unit.reps, Math.ceil((nread - position) / unit.bytes)))
        for (let rep = 0; rep < reps; rep++) {
          const last = rep === unit.reps - 1 && unit.reps > 1
          for (let p = 0; p < unit.pieces.length; p++) {
            const piece = unit.pieces[p]
            if (piece.text !== undefined) {
              let text = piece.text
              if (last && p === unit.pieces.length - 1) text = text.replace(/[ \t]+$/, '')
              out += asBytes(text)
              continue
            }
            const blank = position >= nread && piece.kind !== '_a' && piece.kind !== '_A'
            if (piece.kind === '_p') { const byte = block[position]; out += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.' }
            else out += render(piece, block, position, address + position, blank, endAddress)
            position += piece.size
          }
        }
        if (shrinks) position += (unit.reps - reps) * unit.bytes
      }
    }
  }
  if (endAddress > 0) for (const fs of atEnd) {
    for (const unit of fs.units) for (const piece of unit.pieces) out += piece.text !== undefined ? asBytes(piece.text) : render(piece, new Uint8Array(1), 0, endAddress, false, endAddress)
  }
  writeFdBytes(1, Uint8Array.from(out, ch => ch.charCodeAt(0)))
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
