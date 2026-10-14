/**
 * Compare two files byte by byte, as GNU `cmp` does: the first difference is reported on standard output as `a b differ: byte N,
 * line L`, `-l` lists every differing byte (in octal), `-b` shows the bytes, `-s` is silent, `-n LIMIT` stops after LIMIT bytes and
 * `-i SKIP[:SKIP2]` skips bytes at the start. Exit 0 for the same, 1 for different, 2 for trouble.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`cmp: ${text}\n`))
const out = text => writeAll(1, encoder.encode(text))

const usage = `Usage: cmp [OPTION]... FILE1 [FILE2 [SKIP1 [SKIP2]]]
Compare two files byte by byte. With no FILE, or when FILE is -, read standard input.

  -b, --print-bytes          print differing bytes
  -i, --ignore-initial=SKIP  skip first SKIP bytes of both inputs
  -i, --ignore-initial=SKIP1:SKIP2  skip first SKIP1 bytes of FILE1 and first SKIP2 bytes of FILE2
  -l, --verbose              output byte numbers and differing byte values
  -n, --bytes=LIMIT          compare at most LIMIT bytes
  -s, --quiet, --silent      suppress all normal output
  --help                     display this help and exit`

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

const octal = byte => byte.toString(8)
/** A byte as `cmp -b` shows it: `^@` for control characters, `M-` before one with the high bit */
function show(byte) {
  let text = ''
  if (byte >= 128) { text = 'M-'; byte -= 128 }
  if (byte < 32) return text + '^' + String.fromCharCode(byte + 64)
  if (byte === 127) return text + '^?'
  return text + String.fromCharCode(byte)
}

function main() {
  const args = argv.slice(1)
  let printBytes = false
  let verbose = false
  let quiet = false
  let limit = Infinity
  let skips = [0, 0]
  const operands = []

  const number = text => (/^\d+$/.test(text ?? '') ? Number(text) : undefined)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { operands.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { operands.push(arg); continue }
    if (arg === '--print-bytes') { printBytes = true; continue }
    if (arg === '--verbose') { verbose = true; continue }
    if (arg === '--quiet' || arg === '--silent') { quiet = true; continue }
    const long = /^--(bytes|ignore-initial)(?:=(.*))?$/.exec(arg)
    if (long) {
      const value = long[2] !== undefined ? long[2] : args[++i]
      if (long[1] === 'bytes') { limit = number(value); if (limit === undefined) { err(`invalid --bytes value '${value}'`); return 2 } }
      else {
        const [one, two = one] = (value ?? '').split(':')
        skips = [number(one), number(two)]
        if (skips.includes(undefined)) { err(`invalid --ignore-initial value '${value}'`); return 2 }
      }
      continue
    }
    if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'cmp --help' for more information."); return 2 }
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'b') printBytes = true
      else if (flag === 'l') verbose = true
      else if (flag === 's') quiet = true
      else if (flag === 'n' || flag === 'i') {
        const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        if (flag === 'n') { limit = number(value); if (limit === undefined) { err(`invalid --bytes value '${value}'`); return 2 } }
        else {
          const [one, two = one] = (value ?? '').split(':')
          skips = [number(one), number(two)]
          if (skips.includes(undefined)) { err(`invalid --ignore-initial value '${value}'`); return 2 }
        }
        break
      } else { err(`invalid option -- '${flag}'`); err("Try 'cmp --help' for more information."); return 2 }
    }
  }

  if (operands.length === 0) { err('missing operand after \'cmp\''); err("Try 'cmp --help' for more information."); return 2 }
  if (operands.length > 4) { err(`extra operand '${operands[4]}'`); err("Try 'cmp --help' for more information."); return 2 }
  const [first, second = '-'] = operands
  // Skips may also come as the third and fourth operands
  if (operands[2] !== undefined) skips[0] = number(operands[2]) ?? 0
  if (operands[3] !== undefined) skips[1] = number(operands[3]) ?? 0

  const cwd = getcwd()
  const names = [first, second]
  const data = []
  for (const name of names) {
    try {
      if (name === '-') { data.push(readFd(0)); continue }
      const fullPath = resolve(cwd, name)
      if (isDirectory(fullPath)) { data.push(new Uint8Array(0)); continue }
      const fd = open(fullPath, O_RDONLY)
      try { data.push(readFd(fd)) } finally { close(fd) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${name}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      return 2
    }
  }

  const a = data[0].subarray(Math.min(skips[0], data[0].length))
  const b = data[1].subarray(Math.min(skips[1], data[1].length))
  const common = Math.min(a.length, b.length, limit)

  let line = 1
  let differ = false
  let report = ''
  for (let i = 0; i < common; i++) {
    if (a[i] !== b[i]) {
      differ = true
      if (quiet) return 1
      if (verbose) {
        report += printBytes
          ? `${String(i + 1).padStart(7)} ${octal(a[i]).padStart(3)} ${show(a[i]).padEnd(4)} ${octal(b[i]).padStart(3)} ${show(b[i])}\n`
          : `${String(i + 1).padStart(Math.max(2, String(common).length))} ${octal(a[i]).padStart(3)} ${octal(b[i]).padStart(3)}\n`
      } else {
        out(`${first} ${second} differ: byte ${i + 1}, line ${line}${printBytes ? ` is ${octal(a[i]).padStart(3)} ${show(a[i])} ${octal(b[i]).padStart(3)} ${show(b[i])}` : ''}\n`)
        return 1
      }
    }
    if (a[i] === 10) line++
  }
  if (report) out(report)

  // One file ended before the other, within the limit
  if (limit > common && a.length !== b.length) {
    if (!quiet) err(`EOF on ${a.length < b.length ? first : second}${common === 0 ? ' which is empty' : ` after byte ${common}`}`)
    return 1
  }
  return differ ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(2)
}
