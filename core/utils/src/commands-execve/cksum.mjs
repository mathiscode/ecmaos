/**
 * `cksum`: print a checksum and the size of each file. The default is the POSIX CRC; `-a` picks another algorithm
 * (`sysv`, `bsd`, `md5`, `sha1`, `sha256`, `sha384`, `sha512`), which print in the BSD tagged form unless `--untagged` is
 * given, as GNU cksum does.
 */

import { digestHex } from './lib/digest.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, typeof text === 'string' ? encoder.encode(text) : text)
const err = text => writeAll(2, encoder.encode(`cksum: ${text}\n`))

const usage = `Usage: cksum [OPTION]... [FILE]...
Print or verify checksums. By default use the 32 bit CRC algorithm. With no FILE, or when FILE is -, read standard input.

  -a, --algorithm=TYPE  select the digest type to use: sysv, bsd, crc, md5, sha1, sha256, sha384, sha512
      --base64          emit base64-encoded digests, not hexadecimal
  -c, --check           read checksums from the FILEs and check them
      --raw             emit a raw binary digest, not hexadecimal
      --tag             create a BSD-style checksum (the default except for crc, sysv and bsd)
      --untagged        create a reversed style checksum, without digest type
      --quiet           don't print OK for each successfully verified file
      --status          don't output anything, status code shows success
  -w, --warn            warn about improperly formatted checksum lines
      --help            display this help and exit`

const NAMES = { crc: 'CRC', sysv: 'SYSV', bsd: 'BSD', md5: 'MD5', sha1: 'SHA1', sha256: 'SHA256', sha384: 'SHA384', sha512: 'SHA512' }
const HEX_LENGTH = { md5: 32, sha1: 40, sha256: 64, sha384: 96, sha512: 128 }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i << 24
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1
    table[i] = crc >>> 0
  }
  return table
})()

/** The POSIX CRC: the bytes, then the length as little-endian bytes without leading zeros, complemented. */
function posixCrc(bytes) {
  let crc = 0
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
  for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ (length & 0xff)) & 0xff]) >>> 0
  return ~crc >>> 0
}

function sysv(bytes) {
  let sum = 0
  for (const byte of bytes) sum += byte
  const r = (sum & 0xffff) + Math.floor(sum / 65536)
  return { sum: (r & 0xffff) + (r >>> 16), blocks: Math.ceil(bytes.length / 512) }
}

function bsd(bytes) {
  let sum = 0
  for (const byte of bytes) sum = (((sum >>> 1) + ((sum & 1) << 15)) + byte) & 0xffff
  return { sum, blocks: Math.ceil(bytes.length / 1024) }
}

const toBase64 = hex => btoa(String.fromCharCode(...hex.match(/../g).map(pair => parseInt(pair, 16))))

async function line(algorithm, file, bytes, o) {
  const name = file === '-' ? '-' : file
  if (algorithm === 'crc') return `${posixCrc(bytes)} ${bytes.length}${file === '-' && o.stdinNameless ? '' : ` ${name}`}\n`
  if (algorithm === 'sysv') { const { sum, blocks } = sysv(bytes); return `${sum} ${blocks}${o.stdinNameless ? '' : ` ${name}`}\n` }
  if (algorithm === 'bsd') { const { sum, blocks } = bsd(bytes); return `${String(sum).padStart(5, '0')} ${String(blocks).padStart(5)}${o.stdinNameless ? '' : ` ${name}`}\n` }
  const hex = await digestHex(algorithm, bytes)
  const digest = o.base64 ? toBase64(hex) : hex
  return o.tag ? `${NAMES[algorithm]} (${name}) = ${digest}\n` : `${digest}  ${name}\n`
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'a:cw',
    long: { algorithm: { key: 'a', arg: 'required' }, base64: 'base64', check: 'c', raw: 'raw', tag: 'tag', untagged: 'untagged', quiet: 'quiet', status: 'status', warn: 'w', help: 'help', 'ignore-missing': 'ignore-missing', strict: 'strict', debug: 'debug', zero: 'zero', length: { key: 'length', arg: 'required' } }
  })
  if (error) { err(error); err("Try 'cksum --help' for more information."); return 1 }
  const o = { algorithm: 'crc', check: false, tag: undefined, base64: false, raw: false, quiet: false, status: false }
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 'a') {
      if (!(value in NAMES)) { err(`invalid argument '${value}' for '--algorithm'`); err("Try 'cksum --help' for more information."); return 1 }
      o.algorithm = value
    } else if (key === 'c') o.check = true
    else if (key === 'tag') o.tag = true
    else if (key === 'untagged') o.tag = false
    else if (key === 'base64') o.base64 = true
    else if (key === 'raw') o.raw = true
    else if (key === 'quiet') o.quiet = true
    else if (key === 'status') o.status = true
  }
  const hashed = !['crc', 'sysv', 'bsd'].includes(o.algorithm)
  if (o.tag === undefined) o.tag = hashed
  if (!hashed && o.tag && options.some(([key]) => key === 'tag')) { err('--tag is not supported with the checksum algorithm selected'); return 1 }
  if (o.raw && operands.length > 1) { err('the --raw option is not supported with multiple files'); return 1 }
  const files = operands.length ? operands : ['-']
  const cwd = getcwd()
  const load = file => file === '-' ? readFdBytes(0) : readFileBytes(resolve(cwd, file))

  if (o.check) return await check(files, load, o)

  let failed = false
  for (const file of files) {
    let bytes
    try { bytes = load(file) } catch (e) { err(`${file}: ${e?.code === 'EISDIR' || /is a directory/i.test(e?.message ?? '') ? 'Is a directory' : (e?.message ?? e)}`); failed = true; continue }
    o.stdinNameless = file === '-' && operands.length === 0
    if (o.raw) {
      const hex = hashed ? await digestHex(o.algorithm, bytes) : undefined
      if (hex) out(Uint8Array.from(hex.match(/../g).map(pair => parseInt(pair, 16))))
      else if (o.algorithm === 'crc') out(Uint8Array.of(...[24, 16, 8, 0].map(shift => (posixCrc(bytes) >>> shift) & 0xff)))
      else { const { sum } = o.algorithm === 'sysv' ? sysv(bytes) : bsd(bytes); out(Uint8Array.of(sum >> 8, sum & 0xff)) }
      continue
    }
    out(await line(o.algorithm, o.stdinNameless ? '-' : file, bytes, o))
  }
  return failed ? 1 : 0
}

/** `cksum -c`: tagged lines name their own algorithm; untagged ones use `-a` */
async function check(files, load, o) {
  let bad = 0
  let unreadable = 0
  let malformed = 0
  let noLines = 0
  for (const list of files) {
    let text
    try { text = new TextDecoder().decode(load(list)) } catch (e) { err(`${list}: ${e?.message ?? e}`); unreadable++; continue }
    let valid = 0
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      const tagged = /^([A-Za-z0-9]+) \((.*)\) = ([0-9a-fA-F]+|[A-Za-z0-9+/=]+)$/.exec(raw)
      const plain = new RegExp(`^([0-9a-fA-F]{${HEX_LENGTH[o.algorithm] ?? 0}}) [ *](.*)$`).exec(raw)
      let algorithm = o.algorithm
      let file
      let expected
      if (tagged) {
        algorithm = Object.keys(NAMES).find(key => NAMES[key] === tagged[1])
        file = tagged[2]
        expected = tagged[3].toLowerCase()
      } else if (plain) { file = plain[2]; expected = plain[1].toLowerCase() }
      if (!file || !algorithm || !HEX_LENGTH[algorithm] || expected.length !== HEX_LENGTH[algorithm]) { malformed++; continue }
      valid++
      let result
      try { result = (await digestHex(algorithm, load(file))) === expected ? 'OK' : 'FAILED' } catch { result = 'FAILED open or read'; unreadable++ }
      if (result !== 'OK') bad++
      if (!o.status && !(o.quiet && result === 'OK')) out(`${file}: ${result}\n`)
    }
    if (valid === 0) { err(`${list === '-' ? "'standard input'" : list}: no properly formatted checksum lines found`); noLines++ }
  }
  if (!o.status) {
    if (malformed) err(`WARNING: ${malformed} line${malformed === 1 ? ' is' : 's are'} improperly formatted`)
    if (unreadable) err(`WARNING: ${unreadable} listed file${unreadable === 1 ? '' : 's'} could not be read`)
    if (bad) err(`WARNING: ${bad} computed checksum${bad === 1 ? '' : 's'} did NOT match`)
  }
  return noLines || bad || unreadable ? 1 : 0
}

try {
  exit(await main())
} catch (e) {
  err(e instanceof Error ? e.message : String(e))
  exit(1)
}
