/**
 * Copy a file, converting and formatting it, as GNU `dd` does. Operands are `if= of= bs= ibs= obs= cbs= count= skip=
 * seek= status= conv= iflag= oflag=`; numbers take the `b c w k K M G ...` suffixes and `x` products (`2x512`). Input
 * is read in `ibs` blocks, converted (`ucase lcase swab sync block unblock`), and written in `obs` blocks unless `bs=`
 * alone asks for each block to go through as it is read. The `full+partial records` and the byte count are reported on
 * standard error when it finishes.
 */

import { resolve } from './lib/path-utils.mjs'
import { reasonOf, is } from './lib/errno.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`${text}\n`))
const quote = text => `‘${text}’`

const usage = `Usage: dd [OPERAND]...
  or:  dd OPTION
Copy a file, converting and formatting according to the operands.

  bs=BYTES        read and write up to BYTES bytes at a time (default: 512);
                  overrides ibs and obs
  cbs=BYTES       convert BYTES bytes at a time
  conv=CONVS      convert the file as per the comma separated symbol list
  count=N         copy only N input blocks
  ibs=BYTES       read up to BYTES bytes at a time (default: 512)
  if=FILE         read from FILE instead of stdin
  iflag=FLAGS     read as per the comma separated symbol list
  obs=BYTES       write BYTES bytes at a time (default: 512)
  of=FILE         write to FILE instead of stdout
  oflag=FLAGS     write as per the comma separated symbol list
  seek=N          skip N obs-sized output blocks
  skip=N          skip N ibs-sized input blocks
  status=LEVEL    The LEVEL of information to print to stderr;
                  'none' suppresses everything but error messages,
                  'noxfer' suppresses the final transfer statistics,
                  'progress' shows periodic transfer statistics

N and BYTES may be followed by the following multiplicative suffixes:
c=1, w=2, b=512, kB=1000, K=1024, MB=1000*1000, M=1024*1024, xM=M,
GB=1000*1000*1000, G=1024*1024*1024, and so on for T, P, E, Z, Y, R, Q.
Binary prefixes can be used, too: KiB=K, MiB=M, and so on.

Each CONV symbol may be:

  lcase     change upper case to lower case
  ucase     change lower case to upper case
  swab      swap every pair of input bytes
  block     pad newline-terminated records with spaces to cbs-size
  unblock   replace trailing spaces in cbs-size records with newline
  sync      pad every input block with NULs to ibs-size; when used
              with block or unblock, pad with spaces rather than NULs
  excl      fail if the output file already exists
  nocreat   do not create the output file
  notrunc   do not truncate the output file
  noerror   continue after read errors
  fdatasync physically write output file data before finishing
  fsync     likewise, but also write metadata

Each FLAG symbol may be:

  append    append mode (makes sense only for output; conv=notrunc suggested)
  count_bytes  treat 'count=N' as a byte count (iflag only)
  skip_bytes   treat 'skip=N' as a byte count (iflag only)
  seek_bytes   treat 'seek=N' as a byte count (oflag only)
  fullblock  accumulate full blocks of input (iflag only)

Sending a USR1 signal to a running 'dd' process makes it
print I/O statistics to standard error and then resume copying.

      --help     display this help and exit
      --version  output version information and exit
`

const SUFFIX = {
  c: 1, w: 2, b: 512, kB: 1000, K: 1024, k: 1024, KiB: 1024, MB: 1000 ** 2, M: 1024 ** 2, MiB: 1024 ** 2, GB: 1000 ** 3, G: 1024 ** 3,
  GiB: 1024 ** 3, TB: 1000 ** 4, T: 1024 ** 4, TiB: 1024 ** 4, PB: 1000 ** 5, P: 1024 ** 5, PiB: 1024 ** 5, EB: 1000 ** 6, E: 1024 ** 6, EiB: 1024 ** 6
}

/** `2x512K`: a product of numbers with suffixes; `undefined` when it is none */
function parseNumber(text) {
  if (text === '') return undefined
  let product = 1
  for (const factor of text.split('x')) {
    const match = /^(\d+)([A-Za-z]*)$/.exec(factor)
    if (!match) return undefined
    const unit = match[2] === '' ? 1 : SUFFIX[match[2]]
    if (unit === undefined) return undefined
    product *= Number(match[1]) * unit
  }
  return Number.isSafeInteger(product) ? product : undefined
}

const ucase = byte => (byte >= 97 && byte <= 122 ? byte - 32 : byte)
const lcase = byte => (byte >= 65 && byte <= 90 ? byte + 32 : byte)

/** `%g`-like seconds: 5 significant digits, exponent form for tiny values */
function seconds(value) {
  if (value === 0) return '0'
  const text = Number(value.toPrecision(5))
  return value < 1e-4 || value >= 1e5 ? value.toExponential(4).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2') : String(text)
}

function humanSI(bytes) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++ }
  return value < 10 && unit > 0 ? `${(Math.round(value * 10) / 10).toFixed(1)} ${units[unit]}` : `${Math.round(value)} ${units[unit]}`
}
function humanIEC(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return value < 10 && unit > 0 ? `${(Math.round(value * 10) / 10).toFixed(1)} ${units[unit]}` : `${Math.round(value)} ${units[unit]}`
}

function main() {
  const args = argv.slice(1)
  if (args[0] === '--help') { out(usage); return 0 }
  if (args[0] === '--version') { out('dd (ecmaOS coreutils) 1.0\n'); return 0 }

  const s = {
    input: undefined, output: undefined, ibs: 512, obs: 512, bs: undefined, cbs: 0, count: undefined, skip: 0, seek: 0,
    status: 'default', convs: new Set(), iflags: new Set(), oflags: new Set()
  }
  const number = (text, what, { positive = false } = {}) => {
    const value = parseNumber(text)
    if (value === undefined || (positive && value <= 0)) { err(`dd: invalid number: '${text}'`); return undefined }
    return value
  }
  const CONV = new Set(['lcase', 'ucase', 'swab', 'block', 'unblock', 'sync', 'excl', 'nocreat', 'notrunc', 'noerror', 'fdatasync', 'fsync'])
  const IFLAGS = new Set(['count_bytes', 'skip_bytes', 'fullblock', 'direct', 'directory', 'dsync', 'sync', 'nonblock', 'noatime', 'nocache', 'noctty', 'nofollow', 'binary', 'text'])
  const OFLAGS = new Set(['append', 'seek_bytes', 'direct', 'directory', 'dsync', 'sync', 'nonblock', 'noatime', 'nocache', 'noctty', 'nofollow', 'binary', 'text'])
  for (const arg of args) {
    const eq = arg.indexOf('=')
    if (eq <= 0) { err(`dd: unrecognized operand ${quote(arg)}`); err("Try 'dd --help' for more information."); return 1 }
    const key = arg.slice(0, eq)
    const value = arg.slice(eq + 1)
    let n
    switch (key) {
      case 'if': s.input = value; break
      case 'of': s.output = value; break
      case 'bs': if ((n = number(value, key, { positive: true })) === undefined) return 1; s.bs = n; break
      case 'ibs': if ((n = number(value, key, { positive: true })) === undefined) return 1; s.ibs = n; break
      case 'obs': if ((n = number(value, key, { positive: true })) === undefined) return 1; s.obs = n; break
      case 'cbs': if ((n = number(value, key, { positive: true })) === undefined) return 1; s.cbs = n; break
      case 'count': if ((n = number(value, key)) === undefined) return 1; s.count = n; break
      case 'skip': case 'iseek': if ((n = number(value, key)) === undefined) return 1; s.skip = n; break
      case 'seek': case 'oseek': if ((n = number(value, key)) === undefined) return 1; s.seek = n; break
      case 'status':
        if (!['none', 'noxfer', 'progress'].includes(value)) { err(`dd: invalid status level: ${quote(value)}`); err("Try 'dd --help' for more information."); return 1 }
        s.status = value
        break
      case 'conv':
        for (const conv of value.split(',')) {
          if (!CONV.has(conv)) { err(`dd: invalid conversion: ${quote(conv)}`); err("Try 'dd --help' for more information."); return 1 }
          s.convs.add(conv)
        }
        break
      case 'iflag':
        for (const flag of value.split(',')) {
          if (!IFLAGS.has(flag)) { err(`dd: invalid input flag: ${quote(flag)}`); err("Try 'dd --help' for more information."); return 1 }
          s.iflags.add(flag)
        }
        break
      case 'oflag':
        for (const flag of value.split(',')) {
          if (!OFLAGS.has(flag)) { err(`dd: invalid output flag: ${quote(flag)}`); err("Try 'dd --help' for more information."); return 1 }
          s.oflags.add(flag)
        }
        break
      default: err(`dd: unrecognized operand ${quote(arg)}`); err("Try 'dd --help' for more information."); return 1
    }
  }
  if (s.bs !== undefined) { s.ibs = s.bs; s.obs = s.bs }
  if (s.convs.has('block') && s.convs.has('unblock')) { err('dd: cannot combine block and unblock'); return 1 }
  if ((s.convs.has('block') || s.convs.has('unblock')) && s.cbs === 0) { err('dd: conv=block and conv=unblock need cbs='); return 1 }
  const cwd = getcwd()
  const started = performance.now()

  let inFd = 0
  let outFd = 1
  let inputSeekable = false
  if (s.input !== undefined) {
    try { inFd = open(resolve(cwd, s.input), O_RDONLY, 0); inputSeekable = true } catch (e) {
      err(`dd: failed to open '${s.input}': ${reasonOf(e)}`)
      return 1
    }
  }
  let outPosition = -1
  if (s.output !== undefined) {
    const path = resolve(cwd, s.output)
    let existing = true
    try { stat(path) } catch { existing = false }
    if (s.convs.has('excl') && existing) { err(`dd: failed to open '${s.output}': File exists`); return 1 }
    if (s.convs.has('nocreat') && !existing) { err(`dd: failed to open '${s.output}': No such file or directory`); return 1 }
    let flags = O_WRONLY | (s.convs.has('nocreat') ? 0 : O_CREAT)
    if (!s.convs.has('notrunc')) flags |= O_TRUNC
    try { outFd = open(path, flags, 0o666) } catch (e) {
      err(`dd: failed to open '${s.output}': ${reasonOf(e)}`)
      return 1
    }
    outPosition = 0
    if (s.oflags.has('append')) { try { outPosition = Number(stat(path).size) } catch { outPosition = 0 } }
  }

  // skip: seek on a file, read and discard from a stream
  let inPosition = inputSeekable ? 0 : -1
  const skipBytes = s.iflags.has('skip_bytes') ? s.skip : s.skip * s.ibs
  if (skipBytes > 0) {
    if (inputSeekable) inPosition = skipBytes
    else {
      let left = skipBytes
      const scratch = new Uint8Array(Math.min(65536, Math.max(1, s.ibs)))
      while (left > 0) {
        const n = read(inFd, scratch.subarray(0, Math.min(scratch.length, left)), -1)
        if (n <= 0) break
        left -= n
      }
    }
  }
  const seekBytes = s.oflags.has('seek_bytes') ? s.seek : s.seek * s.obs
  if (seekBytes > 0) {
    if (outPosition >= 0) outPosition = (s.oflags.has('append') ? outPosition : 0) + seekBytes
    else writeAll(outFd, new Uint8Array(seekBytes))
  }

  const reblock = !(s.bs !== undefined && [...s.convs].every(c => c === 'sync' || c === 'noerror' || c === 'notrunc' || c === 'fsync' || c === 'fdatasync'))
  const counts = { inFull: 0, inPartial: 0, outFull: 0, outPartial: 0, bytes: 0 }
  let failed = false
  const emit = bytes => {
    if (bytes.length === 0) return
    if (outPosition >= 0) { writeAll(outFd, bytes, outPosition); outPosition += bytes.length } else writeAll(outFd, bytes)
    counts.bytes += bytes.length
    if (bytes.length === s.obs) counts.outFull++
    else counts.outPartial++
  }

  let pending = new Uint8Array(0)
  const queue = bytes => {
    if (!reblock) { emit(bytes); return }
    const joined = new Uint8Array(pending.length + bytes.length)
    joined.set(pending)
    joined.set(bytes, pending.length)
    let at = 0
    while (joined.length - at >= s.obs) { emit(joined.subarray(at, at + s.obs)); at += s.obs }
    pending = joined.slice(at)
  }

  // block / unblock keep a partial record across input blocks
  let carry = new Uint8Array(0)
  const convertBlock = (data, last) => {
    let bytes = data
    if (s.convs.has('swab')) {
      const swapped = new Uint8Array(bytes.length)
      for (let i = 0; i + 1 < bytes.length; i += 2) { swapped[i] = bytes[i + 1]; swapped[i + 1] = bytes[i] }
      if (bytes.length % 2) swapped[bytes.length - 1] = bytes[bytes.length - 1]
      bytes = swapped
    }
    if (s.convs.has('ucase')) bytes = bytes.map(ucase)
    if (s.convs.has('lcase')) bytes = bytes.map(lcase)
    if (s.convs.has('block')) {
      const joined = new Uint8Array(carry.length + bytes.length)
      joined.set(carry); joined.set(bytes, carry.length)
      const records = []
      let begin = 0
      for (let i = 0; i < joined.length; i++) {
        if (joined[i] !== 10) continue
        const record = new Uint8Array(s.cbs).fill(32)
        record.set(joined.subarray(begin, i).subarray(0, s.cbs))
        records.push(record)
        begin = i + 1
      }
      carry = joined.slice(begin)
      if (last && carry.length) {
        const record = new Uint8Array(s.cbs).fill(32)
        record.set(carry.subarray(0, s.cbs))
        records.push(record)
        carry = new Uint8Array(0)
      }
      const merged = new Uint8Array(records.length * s.cbs)
      records.forEach((record, index) => merged.set(record, index * s.cbs))
      return merged
    }
    if (s.convs.has('unblock')) {
      const joined = new Uint8Array(carry.length + bytes.length)
      joined.set(carry); joined.set(bytes, carry.length)
      const pieces = []
      let at = 0
      while (joined.length - at >= s.cbs) {
        let end = at + s.cbs
        while (end > at && joined[end - 1] === 32) end--
        pieces.push(joined.subarray(at, end), Uint8Array.of(10))
        at += s.cbs
      }
      carry = joined.slice(at)
      if (last && carry.length) {
        let end = carry.length
        while (end > 0 && carry[end - 1] === 32) end--
        pieces.push(carry.subarray(0, end), Uint8Array.of(10))
        carry = new Uint8Array(0)
      }
      const merged = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0))
      let offset = 0
      for (const piece of pieces) { merged.set(piece, offset); offset += piece.length }
      return merged
    }
    return bytes
  }

  try {
    const buffer = new Uint8Array(s.ibs)
    let blocks = 0
    let bytesRead = 0
    const byteLimit = s.iflags.has('count_bytes') ? s.count : undefined
    const wantBlocks = s.iflags.has('count_bytes') ? undefined : s.count
    for (;;) {
      if (wantBlocks !== undefined && blocks >= wantBlocks) break
      if (byteLimit !== undefined && bytesRead >= byteLimit) break
      let limit = s.ibs
      if (byteLimit !== undefined) limit = Math.min(limit, byteLimit - bytesRead)
      let n = 0
      try {
        if (s.iflags.has('fullblock')) {
          while (n < limit) {
            const got = read(inFd, buffer.subarray(n, limit), inPosition >= 0 ? inPosition + n : -1)
            if (got <= 0) break
            n += got
          }
        } else n = read(inFd, buffer.subarray(0, limit), inPosition)
      } catch (e) {
        err(`dd: error reading '${s.input ?? 'standard input'}': ${reasonOf(e)}`)
        failed = true
        if (!s.convs.has('noerror')) break
        n = 0
        if (inPosition >= 0) inPosition += limit
        if (s.convs.has('sync')) { queue(convertBlock(new Uint8Array(s.ibs), false)); counts.inPartial++ }
        blocks++
        continue
      }
      if (n <= 0) break
      if (inPosition >= 0) inPosition += n
      bytesRead += n
      blocks++
      if (n === s.ibs) counts.inFull++
      else counts.inPartial++
      let data = buffer.slice(0, n)
      if (s.convs.has('sync') && n < s.ibs) {
        const padded = new Uint8Array(s.ibs).fill(s.convs.has('block') || s.convs.has('unblock') ? 32 : 0)
        padded.set(data)
        data = padded
      }
      queue(convertBlock(data, false))
    }
    const tail = convertBlock(new Uint8Array(0), true)
    if (tail.length) queue(tail)
    if (pending.length) { const rest = pending; pending = new Uint8Array(0); emit(rest) }
  } catch (e) {
    err(`dd: ${is(e, 'ENOSPC') ? 'error writing' : 'error'}${s.output ? ` '${s.output}'` : ''}: ${reasonOf(e)}`)
    failed = true
  } finally {
    if (s.input !== undefined) close(inFd)
    if (s.output !== undefined) close(outFd)
  }

  if (s.status !== 'none') {
    err(`${counts.inFull}+${counts.inPartial} records in`)
    err(`${counts.outFull}+${counts.outPartial} records out`)
    if (s.status !== 'noxfer') {
      const elapsed = Math.max((performance.now() - started) / 1000, 1e-9)
      const size = counts.bytes < 1000 ? `${counts.bytes} bytes` : `${counts.bytes} bytes (${humanSI(counts.bytes)}, ${humanIEC(counts.bytes)})`
      const rate = counts.bytes === 0 ? '0.0 kB/s' : `${humanSI(counts.bytes / elapsed)}/s`
      err(`${size} copied, ${seconds(elapsed)} s, ${rate}`)
    }
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(`dd: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
