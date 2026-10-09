/** Print the last lines (or bytes, with `-c`) of each file, or of stdin. Works on bytes, so binary data passes through untouched. */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`tail: ${text}\n`))

const usage = `Usage: tail [OPTION]... [FILE]...
Print the last 10 lines of each FILE to standard output. With more than one FILE, precede each with a header giving its name.
With no FILE, or when FILE is -, read standard input.

  -c, --bytes=[+]NUM   output the last NUM bytes; with +NUM, start at byte NUM of each file
  -n, --lines=[+]NUM   output the last NUM lines, instead of 10; with +NUM, start at line NUM
  -q, --quiet          never print headers giving file names
  -v, --verbose        always print headers giving file names
  --help               display this help and exit

NUM may have a multiplier suffix: b 512, k 1024, m 1048576.`

const readFd = fd => {
  const chunks = []
  for (;;) {
    const buffer = new Uint8Array(65536)
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function readFile(path) {
  const fd = open(path, O_RDONLY)
  try { return readFd(fd) } finally { close(fd) }
}

/** `10`, `+3`, `-3` (same as 3), with an optional b/k/m suffix; `undefined` when it is not a count */
function count(text) {
  const match = /^([+-]?)(\d+)([bkmBKM]?)$/.exec(text ?? '')
  if (!match) return undefined
  const unit = { '': 1, b: 512, k: 1024, m: 1048576 }[match[3].toLowerCase()]
  return { from: match[1] === '+', value: Number(match[2]) * unit }
}

const NEWLINE = 10

function lastLines(bytes, { from, value }) {
  if (from) {
    // +N: everything from line N on (line 1 is the start)
    let line = 1
    let at = 0
    while (line < value && at < bytes.length) { if (bytes[at++] === NEWLINE) line++ }
    return line < value ? new Uint8Array(0) : bytes.subarray(at)
  }
  if (value === 0) return new Uint8Array(0)
  // the last NUM lines: walk back over NUM newlines, not counting one that ends the data
  let end = bytes.length
  let seen = 0
  let at = end
  if (end > 0 && bytes[end - 1] === NEWLINE) at--
  while (at > 0) {
    if (bytes[at - 1] === NEWLINE && ++seen === value) break
    at--
  }
  return bytes.subarray(at)
}

function lastBytes(bytes, { from, value }) {
  if (from) return bytes.subarray(Math.max(0, value - 1))
  return value === 0 ? new Uint8Array(0) : bytes.subarray(Math.max(0, bytes.length - value))
}

function main() {
  const args = argv.slice(1)
  let amount = { from: false, value: 10 }
  let bytesMode = false
  let header
  const files = []
  const bad = (what, text) => { err(`invalid number of ${what}: '${text}'`); return 1 }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help' || arg === '-h') { writeAll(2, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-q' || arg === '--quiet' || arg === '--silent') { header = false; continue }
    if (arg === '-v' || arg === '--verbose') { header = true; continue }
    const long = /^--(lines|bytes)(?:=(.*))?$/.exec(arg)
    const short = /^-([nc])(.*)$/.exec(arg)
    if (long || short) {
      const isBytes = long ? long[1] === 'bytes' : short[1] === 'c'
      let text = long ? long[2] : short[2]
      if (text === undefined || text === '') text = args[++i]
      const parsed = count(text)
      if (!parsed) return bad(isBytes ? 'bytes' : 'lines', text ?? '')
      amount = parsed
      bytesMode = isBytes
    } else if (/^-\d+$/.test(arg)) {
      // the obsolete `tail -3`
      amount = { from: false, value: Number(arg.slice(1)) }
      bytesMode = false
    } else if (arg.startsWith('-') && arg !== '-') {
      err(`invalid option -- '${arg.replace(/^-+/, '')}'`)
      return 1
    } else files.push(arg)
  }

  const pick = bytes => (bytesMode ? lastBytes(bytes, amount) : lastLines(bytes, amount))

  if (files.length === 0) {
    writeAll(1, pick(readFd(0)))
    return 0
  }

  const cwd = getcwd()
  const headers = header ?? files.length > 1
  let failed = false
  files.forEach((file, index) => {
    if (headers) writeAll(1, encoder.encode(`${index > 0 ? '\n' : ''}==> ${file === '-' ? 'standard input' : file} <==\n`))
    try {
      const bytes = file === '-' ? readFd(0) : (stat(resolve(cwd, file)), readFile(resolve(cwd, file)))
      writeAll(1, pick(bytes))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`cannot open '${file}' for reading: ${/ENOENT/.test(message) ? 'No such file or directory' : message}`)
      failed = true
    }
  })
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
