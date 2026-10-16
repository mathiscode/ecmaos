/** Encode or decode base64 as GNU `base64` does: `base64 file`, `echo hello | base64`, `base64 -d`. */

import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`base64: ${text}\n`))

const usage = `Usage: base64 [OPTION]... [FILE]
Base64 encode or decode FILE, or standard input, to standard output.

With no FILE, or when FILE is -, read standard input.

  -d, --decode          decode data
  -i, --ignore-garbage  when decoding, ignore non-alphabet characters
  -w, --wrap=COLS       wrap encoded lines after COLS character (default 76).
                          Use 0 to disable line wrapping
      --help            display this help and exit`

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const VALUE = Object.fromEntries([...ALPHABET].map((char, index) => [char, index]))

function encode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2]
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : ALPHABET[c & 63]
  }
  return out
}

/**
 * Decodes as far as the input is valid: `{ bytes, ok }`. A bad character ends the output at the bytes the good ones before
 * it make (a half-finished group gives its whole bytes), as GNU's does. Newlines are always skipped; a missing final `=`
 * padding is accepted.
 */
function decode(text, ignoreGarbage) {
  const bytes = []
  let group = []
  const flush = () => {
    if (group.length >= 2) bytes.push((group[0] << 2) | (group[1] >> 4))
    if (group.length >= 3) bytes.push(((group[1] & 15) << 4) | (group[2] >> 2))
    if (group.length >= 4) bytes.push(((group[2] & 3) << 6) | group[3])
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\n') continue
    if (char in VALUE) {
      group.push(VALUE[char])
      if (group.length === 4) { flush(); group = [] }
      continue
    }
    if (char === '=' && group.length >= 2) {
      flush()
      let need = 4 - group.length - 1
      group = []
      while (need > 0) {
        const next = text[++i]
        if (next === '\n') continue
        if (next !== '=') return { bytes, ok: false }
        need--
      }
      continue
    }
    if (ignoreGarbage) continue
    flush()
    return { bytes, ok: false }
  }
  if (group.length === 1) return { bytes, ok: false }
  flush()
  return { bytes, ok: true }
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'diw:', long: { decode: 'd', 'ignore-garbage': 'i', wrap: { key: 'w', arg: 'required' }, help: 'help', version: 'version' } })
  if (error) { err(error); err("Try 'base64 --help' for more information."); return 1 }
  let decoding = false
  let ignoreGarbage = false
  let wrap = 76
  for (const [key, value] of options) {
    if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'd') decoding = true
    else if (key === 'i') ignoreGarbage = true
    else if (key === 'w') {
      wrap = /^\d+$/.test(value) ? Number(value) : NaN
      if (Number.isNaN(wrap)) { err(`invalid wrap size: ‘${value}’`); return 1 }
    }
  }
  if (operands.length > 1) { err(`extra operand ‘${operands[1]}’`); err("Try 'base64 --help' for more information."); return 1 }
  let bytes
  try { bytes = operands[0] === undefined || operands[0] === '-' ? readFdBytes(0) : readFileBytes(resolve(getcwd(), operands[0])) } catch (e) {
    err(`${operands[0]}: ${e?.code === 'EISDIR' ? 'read error: Is a directory' : (e?.message ?? e)}`)
    return 1
  }
  if (decoding) {
    const { bytes: decoded, ok } = decode(new TextDecoder('latin1').decode(bytes), ignoreGarbage)
    if (decoded.length) writeAll(1, Uint8Array.from(decoded))
    if (!ok) { err('invalid input'); return 1 }
    return 0
  }
  const text = encode(bytes)
  if (text === '') return 0
  writeAll(1, encoder.encode(wrap === 0 ? text : text.replace(new RegExp(`.{1,${wrap}}`, 'g'), '$&\n')))
  return 0
}

try {
  exit(main())
} catch (e) {
  err(e?.message ?? String(e))
  exit(1)
}
