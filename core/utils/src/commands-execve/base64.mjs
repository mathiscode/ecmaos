/** Encode or decode base64: `base64 file`, `echo hello | base64`, `base64 -d`. */

import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`base64: ${text}\n`))

const usage = `Usage: base64 [OPTION]... [FILE]
Base64 encode or decode FILE, or standard input, to standard output.

  -d, --decode          decode data
  -i, --ignore-garbage  when decoding, ignore characters outside the alphabet
  -w, --wrap=COLS       wrap encoded lines after COLS characters (default 76); 0 never wraps
  --help                display this help and exit`

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

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

/** The bytes of base64 `text`, or undefined when it is not valid. Whitespace is always skipped. */
function decode(text, ignoreGarbage) {
  let clean = ''
  for (const char of text) {
    if (char === '\n' || char === '\r' || char === ' ' || char === '\t') continue
    if (ALPHABET.includes(char) || char === '=') clean += char
    else if (!ignoreGarbage) return undefined
  }
  const body = clean.replace(/=+$/, '')
  if (clean.length - body.length > 2 || body.includes('=') || (clean.length % 4 !== 0 && !ignoreGarbage) || body.length % 4 === 1) return undefined
  const out = []
  for (let i = 0; i < body.length; i += 4) {
    const n = [0, 1, 2, 3].map(k => body[i + k] === undefined ? 0 : ALPHABET.indexOf(body[i + k]))
    const count = Math.min(4, body.length - i)
    out.push((n[0] << 2) | (n[1] >> 4))
    if (count > 2) out.push(((n[1] & 15) << 4) | (n[2] >> 2))
    if (count > 3) out.push(((n[2] & 3) << 6) | n[3])
  }
  return Uint8Array.from(out)
}

function main() {
  const args = argv.slice(1)
  let decoding = false
  let ignoreGarbage = false
  let wrap = 76
  const files = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '-d' || arg === '--decode') decoding = true
    else if (arg === '-i' || arg === '--ignore-garbage') ignoreGarbage = true
    else if (arg === '-w' || arg === '--wrap' || arg.startsWith('--wrap=') || /^-w\d+$/.test(arg)) {
      const text = arg.startsWith('--wrap=') ? arg.slice(7) : arg.length > 2 && !arg.startsWith('--') ? arg.slice(2) : args[++i]
      wrap = Number(text)
      if (!Number.isInteger(wrap) || wrap < 0) { err(`invalid wrap size: '${text}'`); return 1 }
    } else if (arg === '-' || !arg.startsWith('-')) files.push(arg)
    else { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); return 1 }
  }
  if (files.length > 1) { err(`extra operand '${files[1]}'`); return 1 }
  let bytes
  try { bytes = files[0] === undefined || files[0] === '-' ? readFdBytes(0) : readFileBytes(resolve(getcwd(), files[0])) } catch (error) {
    err(`${files[0]}: ${error?.message ?? error}`)
    return 1
  }
  if (decoding) {
    const decoded = decode(new TextDecoder().decode(bytes), ignoreGarbage)
    if (!decoded) { err('invalid input'); return 1 }
    writeAll(1, decoded)
    return 0
  }
  const text = encode(bytes)
  if (text === '') return 0
  writeAll(1, encoder.encode(wrap === 0 ? text + '\n' : text.replace(new RegExp(`.{1,${wrap}}`, 'g'), '$&\n')))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
