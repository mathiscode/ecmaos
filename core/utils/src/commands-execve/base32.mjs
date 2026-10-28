/** `base32`: encode or decode base32 (RFC 4648), as GNU base32 does. */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, quotef } from './lib/errno.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`base32: ${text}\n`))
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const usage = `Usage: base32 [OPTION]... [FILE]
Base32 encode or decode FILE, or standard input, to standard output.

With no FILE, or when FILE is -, read standard input.

  -d, --decode          decode data
  -i, --ignore-garbage  when decoding, ignore non-alphabet characters
  -w, --wrap=COLS       wrap encoded lines after COLS character (default 76).
                          Use 0 to disable line wrapping
      --help        display this help and exit
      --version     output version information and exit`

function encode32(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 5) {
    const chunk = bytes.subarray(i, i + 5)
    let bits = 0n
    for (let j = 0; j < 5; j++) bits = (bits << 8n) | BigInt(chunk[j] ?? 0)
    const chars = [2, 4, 5, 7, 8][chunk.length - 1]
    for (let j = 0; j < 8; j++) out += j < chars ? ALPHABET[Number((bits >> BigInt(35 - j * 5)) & 31n)] : '='
  }
  return out
}

function decode32(text, ignoreGarbage) {
  const clean = text.replace(/\s/g, '')
  const chars = []
  for (const c of clean) {
    if (c === '=') { chars.push(c); continue }
    if (ALPHABET.includes(c)) { chars.push(c); continue }
    if (!ignoreGarbage) return undefined
  }
  const joined = chars.join('')
  if (!ignoreGarbage && joined.length % 8 !== 0) return undefined
  const bytes = []
  for (let i = 0; i < joined.length; i += 8) {
    const group = joined.slice(i, i + 8)
    const data = group.replace(/=+$/, '')
    if (data.includes('=')) return undefined
    let bits = 0n
    for (let j = 0; j < 8; j++) bits = (bits << 5n) | BigInt(j < data.length ? ALPHABET.indexOf(data[j]) : 0)
    const count = { 8: 5, 7: 4, 5: 3, 4: 2, 2: 1 }[data.length]
    if (count === undefined) return undefined
    for (let j = 0; j < count; j++) bytes.push(Number((bits >> BigInt(32 - j * 8)) & 255n))
  }
  return new Uint8Array(bytes)
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'diw:', long: { decode: 'd', 'ignore-garbage': 'i', wrap: { key: 'w', arg: 'required' }, help: 'help', version: 'version' } })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('base32') + '\n')); return 1 }
  let decode = false
  let ignore = false
  let wrap = 76
  for (const [key, value] of options) {
    if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'version') { writeAll(1, encoder.encode('base32 (ecmaOS coreutils) 1.0\n')); return 0 }
    if (key === 'd') decode = true
    else if (key === 'i') ignore = true
    else if (key === 'w') {
      if (!/^\d+$/.test(value)) { err(`invalid wrap size: ${quotef(value)}`); return 1 }
      wrap = Number(value)
    }
  }
  if (operands.length > 1) { err(`extra operand ${quotef(operands[1])}`); writeAll(2, encoder.encode(tryHelp('base32') + '\n')); return 1 }
  const file = operands[0] ?? '-'
  let input
  try { input = file === '-' ? readFdBytes(0) : readFileBytes(file) } catch (e) { err(`${file}: ${reasonOf(e)}`); return 1 }
  if (decode) {
    const bytes = decode32(new TextDecoder('latin1').decode(input), ignore)
    if (!bytes) { err('invalid input'); return 1 }
    writeAll(1, bytes)
    return 0
  }
  const text = encode32(input)
  const lines = wrap > 0 ? text.match(new RegExp(`.{1,${wrap}}`, 'g')) ?? [] : [text]
  writeAll(1, encoder.encode(lines.join('\n') + (text ? '\n' : '')))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
