/**
 * `iconv`: convert text from one character encoding to another. Decoding is the browser's (`TextDecoder`, every
 * encoding of the WHATWG Encoding Standard). Encoding is written here: UTF-8, UTF-16 and UTF-32 in either byte order,
 * ASCII, and each single-byte charset (the ISO-8859 parts, the Windows code pages, KOI8, Mac Roman, IBM866), whose
 * table is read back from the decoder. Encoding to the multi-byte East Asian charsets (Shift_JIS, EUC-JP, GBK, Big5,
 * EUC-KR) is not possible, though decoding from them is. `//TRANSLIT` writes `?` for what cannot be written, and
 * `//IGNORE` and `-c` leave it out.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'

const { argv, exit, writeAll, open, close, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`iconv: ${text}\n`))

const usage = `Usage: iconv [OPTION...] [FILE...]
Convert encoding of given files from one encoding to another.

 Input/Output format specification:
  -f, --from-code=NAME       encoding of original text
  -t, --to-code=NAME         encoding for output

 Information:
  -l, --list                 list all known coded character sets

 Output control:
  -c                         omit invalid characters from output
  -o, --output=FILE          output file
  -s, --silent               suppress warnings
      --verbose              print progress information

  -?, --help                 Give this help list
  -V, --version              Print program version`

/** The names `iconv -l` gives, and what the decoder calls each */
const CHARSETS = {
  'UTF-8': 'utf-8', 'UTF-16': 'utf-16le', 'UTF-16LE': 'utf-16le', 'UTF-16BE': 'utf-16be', 'UTF-32': 'utf-32', 'UTF-32LE': 'utf-32le', 'UTF-32BE': 'utf-32be',
  'ASCII': 'ascii', 'ISO-8859-1': 'iso-8859-1', 'ISO-8859-2': 'iso-8859-2', 'ISO-8859-3': 'iso-8859-3', 'ISO-8859-4': 'iso-8859-4', 'ISO-8859-5': 'iso-8859-5',
  'ISO-8859-6': 'iso-8859-6', 'ISO-8859-7': 'iso-8859-7', 'ISO-8859-8': 'iso-8859-8', 'ISO-8859-10': 'iso-8859-10', 'ISO-8859-13': 'iso-8859-13',
  'ISO-8859-14': 'iso-8859-14', 'ISO-8859-15': 'iso-8859-15', 'ISO-8859-16': 'iso-8859-16', 'KOI8-R': 'koi8-r', 'KOI8-U': 'koi8-u', 'MACINTOSH': 'macintosh',
  'IBM866': 'ibm866', 'CP874': 'windows-874', 'CP1250': 'windows-1250', 'CP1251': 'windows-1251', 'CP1252': 'windows-1252', 'CP1253': 'windows-1253',
  'CP1254': 'windows-1254', 'CP1255': 'windows-1255', 'CP1256': 'windows-1256', 'CP1257': 'windows-1257', 'CP1258': 'windows-1258',
  'SHIFT_JIS': 'shift_jis', 'EUC-JP': 'euc-jp', 'ISO-2022-JP': 'iso-2022-jp', 'GBK': 'gbk', 'GB18030': 'gb18030', 'BIG5': 'big5', 'EUC-KR': 'euc-kr'
}
const ALIASES = { UTF8: 'UTF-8', UTF16: 'UTF-16', UTF32: 'UTF-32', 'US-ASCII': 'ASCII', ANSI_X3_4_1968: 'ASCII', LATIN1: 'ISO-8859-1', LATIN2: 'ISO-8859-2', LATIN9: 'ISO-8859-15', L1: 'ISO-8859-1', SJIS: 'SHIFT_JIS', CP932: 'SHIFT_JIS', EUCJP: 'EUC-JP', CP936: 'GBK', EUCKR: 'EUC-KR', CP949: 'EUC-KR', CP950: 'BIG5', MAC: 'MACINTOSH', MACROMAN: 'MACINTOSH', CP866: 'IBM866' }

/** `latin1//TRANSLIT` as `{ name, translit, ignore }`, the name made canonical; undefined for one not known */
function charset(text) {
  const [base, ...flags] = text.split('//')
  let name = base.toUpperCase().replace(/_/g, '-')
  if (/^ISO8859-?(\d+)$/.test(name)) name = `ISO-8859-${/(\d+)$/.exec(name)[1]}`
  if (/^ISO-?8859-(\d+)$/.test(name)) name = `ISO-8859-${/(\d+)$/.exec(name)[1]}`
  if (/^WINDOWS-?(\d+)$/.test(name)) name = `CP${/(\d+)$/.exec(name)[1]}`
  name = ALIASES[name.replace(/-/g, '_')] ?? ALIASES[name] ?? name
  if (!CHARSETS[name]) return undefined
  return { name, translit: flags.some(flag => /^TRANSLIT$/i.test(flag)), ignore: flags.some(flag => /^IGNORE$/i.test(flag)) }
}

function decode(bytes, name, skip) {
  if (name === 'UTF-32' || name === 'UTF-32LE' || name === 'UTF-32BE') {
    let little = name !== 'UTF-32BE'
    let start = 0
    if (name === 'UTF-32' && bytes.length >= 4) {
      if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) { little = false; start = 4 }
      else if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) start = 4
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let text = ''
    for (let i = start; i + 4 <= bytes.length; i += 4) {
      const code = view.getUint32(i, little)
      if (code > 0x10ffff || (code >= 0xd800 && code < 0xe000)) { if (skip) continue; throw Object.assign(new Error(), { position: i }) }
      text += String.fromCodePoint(code)
    }
    if (bytes.length % 4 && !skip) throw Object.assign(new Error('incomplete'), { position: bytes.length - (bytes.length % 4), incomplete: true })
    return text
  }
  if (name === 'ASCII') {
    let text = ''
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] > 127) { if (skip) continue; throw Object.assign(new Error(), { position: i, text }) }
      text += String.fromCharCode(bytes[i])
    }
    return text
  }
  // ISO-8859-1 is every byte as the code point of its value; the decoder's "latin1" is windows-1252
  if (name === 'ISO-8859-1') return Array.from(bytes, byte => String.fromCharCode(byte)).join('')
  // UTF-16 with no byte order named takes it from a BOM, and is little-endian without one
  let label = CHARSETS[name]
  if (name === 'UTF-16' && bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be'
  if (skip) return new TextDecoder(label, { ignoreBOM: false }).decode(bytes).replace(/�/g, '')
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: name !== 'UTF-16' && name !== 'UTF-8' }).decode(bytes)
  } catch {
    // where it went wrong: the longest prefix that decodes
    let low = 0, high = bytes.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      try { new TextDecoder(label, { fatal: true }).decode(bytes.subarray(0, mid)); low = mid } catch { high = mid - 1 }
    }
    throw Object.assign(new Error(), { position: low, text: new TextDecoder(label).decode(bytes.subarray(0, low)) })
  }
}

/** What //TRANSLIT writes for characters a charset lacks, as glibc's tables do for the common ones */
const TRANSLIT = {
  '\u2014': '--', '\u2013': '-', '\u2012': '-', '\u2010': '-', '\u2011': '-', '\u20ac': 'EUR', '\u00a3': 'GBP', '\u00a5': 'JPY', '\u2018': "'", '\u2019': "'", '\u201a': ',',
  '\u201c': '"', '\u201d': '"', '\u201e': ',,', '\u2026': '...', '\u2022': 'o', '\u00a9': '(C)', '\u00ae': '(R)', '\u2122': '(TM)', '\u00ab': '<<', '\u00bb': '>>',
  '\u00df': 'ss', '\u00e6': 'ae', '\u00c6': 'AE', '\u0153': 'oe', '\u0152': 'OE', '\ufb01': 'fi', '\ufb02': 'fl', '\u00bd': ' 1/2', '\u00bc': ' 1/4', '\u00be': ' 3/4',
  '\u00d7': 'x', '\u00f7': ':', '\u00b0': '^0', '\u00a0': ' ', '\u2032': "'", '\u2033': '"', '\u00f8': 'o', '\u00d8': 'O', '\u0142': 'l', '\u0141': 'L', '\u00f0': 'd', '\u00fe': 'th'
}

/** A single-byte charset's table, character to byte, read back from its decoder */
function singleByteTable(label) {
  const table = new Map()
  const decoded = new TextDecoder(label).decode(Uint8Array.from({ length: 256 }, (_, i) => i))
  ;[...decoded].forEach((char, byte) => { if (char !== '�' && !table.has(char)) table.set(char, byte) })
  return table
}

function encode(text, target, skipBad) {
  const { name, translit, ignore } = target
  const omit = skipBad || ignore
  if (name === 'UTF-8') return encoder.encode(text)
  const chars = [...text]
  if (name.startsWith('UTF-16')) {
    const little = name !== 'UTF-16BE'
    const units = []
    for (const char of chars) for (let i = 0; i < char.length; i++) units.push(char.charCodeAt(i))
    const bom = name === 'UTF-16' ? 1 : 0
    const out = new Uint8Array((units.length + bom) * 2)
    const view = new DataView(out.buffer)
    if (bom) view.setUint16(0, 0xfeff, little)
    units.forEach((unit, i) => view.setUint16((i + bom) * 2, unit, little))
    return out
  }
  if (name.startsWith('UTF-32')) {
    const little = name !== 'UTF-32BE'
    const bom = name === 'UTF-32' ? 1 : 0
    const out = new Uint8Array((chars.length + bom) * 4)
    const view = new DataView(out.buffer)
    if (bom) view.setUint32(0, 0xfeff, little)
    chars.forEach((char, i) => view.setUint32((i + bom) * 4, char.codePointAt(0), little))
    return out
  }
  if (['SHIFT_JIS', 'EUC-JP', 'ISO-2022-JP', 'GBK', 'GB18030', 'BIG5', 'EUC-KR'].includes(name)) throw Object.assign(new Error(`conversion to '${name}' is not supported`), { unsupported: true })
  const table = name === 'ASCII' ? new Map(Array.from({ length: 128 }, (_, i) => [String.fromCharCode(i), i]))
    : name === 'ISO-8859-1' ? new Map(Array.from({ length: 256 }, (_, i) => [String.fromCharCode(i), i]))
    : singleByteTable(CHARSETS[name])
  const bytes = []
  let position = 0
  for (const char of chars) {
    const byte = table.get(char)
    if (byte !== undefined) bytes.push(byte)
    else if (translit) {
      const spelled = TRANSLIT[char] !== undefined && [...TRANSLIT[char]].every(c => table.has(c)) ? TRANSLIT[char] : undefined
      if (spelled !== undefined) for (const c of spelled) bytes.push(table.get(c))
      else bytes.push(table.get(char.normalize('NFD')[0]) ?? 63)
    } else if (!omit) throw Object.assign(new Error(), { position, unencodable: true, bytes: new Uint8Array(bytes) })
    position += encoder.encode(char).length
  }
  return new Uint8Array(bytes)
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'f:t:lco:sV?',
    long: { 'from-code': { key: 'f', arg: 'required' }, 'to-code': { key: 't', arg: 'required' }, list: 'l', output: { key: 'o', arg: 'required' }, silent: 's', verbose: 'verbose', help: '?', version: 'V' }
  })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('iconv') + '\n')); return 1 }
  let from = 'UTF-8', to = 'UTF-8', skip = false, output
  for (const [key, value] of options) {
    if (key === '?') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'V') { writeAll(1, encoder.encode('iconv (ecmaOS coreutils) 1.0\n')); return 0 }
    if (key === 'l') { writeAll(1, encoder.encode(Object.keys(CHARSETS).map(name => name + '//').join('\n') + '\n')); return 0 }
    if (key === 'f') from = value
    else if (key === 't') to = value
    else if (key === 'c') skip = true
    else if (key === 'o') output = value
  }
  const source = charset(from)
  const target = charset(to)
  if (!source && !target) { err(`conversions from \`${from}' and to \`${to}' are not supported`); return 1 }
  if (!source) { err(`conversion from \`${from}' is not supported`); return 1 }
  if (!target) { err(`conversion to \`${to}' is not supported`); return 1 }

  const chunks = []
  let status = 0
  for (const file of operands.length ? operands : ['-']) {
    let bytes
    try { bytes = file === '-' ? readFdBytes(0) : readFileBytes(file) } catch (e) { err(`cannot open input file \`${file}': ${reasonOf(e)}`); status = 1; continue }
    try {
      chunks.push(encode(decode(bytes, source.name, skip || target.ignore), target, skip))
    } catch (e) {
      if (e.unsupported) { err(e.message); return 1 }
      // what was converted before the problem is written, as glibc's iconv writes it
      let partial = e.bytes
      if (!partial && e.text !== undefined) { try { partial = encode(e.text, target, true) } catch { partial = undefined } }
      if (partial) chunks.push(partial)
      flush(chunks, output)
      err(e.incomplete ? `incomplete character or shift sequence at end of buffer` : `${e.unencodable ? 'cannot convert' : 'illegal input sequence'} at position ${e.position}`)
      return 1
    }
  }
  return flush(chunks, output) ? status : 1
}

/** Writes the converted chunks to standard output or `output`; false when the file cannot be opened */
function flush(chunks, output) {
  const bytes = chunks.length === 1 ? chunks[0] : Uint8Array.from(chunks.flatMap(chunk => [...chunk]))
  if (output === undefined) { writeAll(1, bytes); return true }
  let fd
  try { fd = open(output, O_WRONLY | O_CREAT | O_TRUNC, 0o666) } catch (e) { err(`cannot open output file: ${reasonOf(e)}`); return false }
  try { writeAll(fd, bytes) } finally { close(fd) }
  return true
}

try {
  exit(main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
