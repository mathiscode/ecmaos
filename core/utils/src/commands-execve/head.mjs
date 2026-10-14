/**
 * Print the first lines (or bytes, with `-c`) of each file, or of stdin, as GNU `head` does: the bytes are passed through
 * untouched (a last line with no newline stays without one), `-n -N` and `-c -N` leave out the last N, and a positive count
 * is read only as far as it needs, so `head -c 16 /dev/urandom` returns.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`head: ${text}\n`))

const usage = `Usage: head [OPTION]... [FILE]...
Print the first 10 lines of each FILE to standard output. With more than one FILE, precede each with a header giving its name.
With no FILE, or when FILE is -, read standard input.

  -c, --bytes=[-]NUM   print the first NUM bytes of each file; with -NUM, print all but the last NUM bytes
  -n, --lines=[-]NUM   print the first NUM lines instead of the first 10; with -NUM, print all but the last NUM lines
  -q, --quiet          never print headers giving file names
  -v, --verbose        always print headers giving file names
  -NUM                 the same as -n NUM
  --help               display this help and exit

NUM may have a multiplier suffix: b 512, kB 1000, K 1024, MB 1000*1000, M 1024*1024, GB, G, TB, T.`

const NEWLINE = 10
const multipliers = { '': 1, b: 512, kB: 1000, K: 1024, k: 1024, MB: 1e6, M: 1048576, m: 1048576, GB: 1e9, G: 2 ** 30, g: 2 ** 30, TB: 1e12, T: 2 ** 40, t: 2 ** 40 }

/** `10`, `-3` (all but the last 3), with an optional multiplier suffix; `undefined` when it is not a count */
function count(text) {
  const match = /^(-?)(\d+)([a-zA-Z]*)$/.exec(text ?? '')
  if (!match || !(match[3] in multipliers)) return undefined
  return { skipLast: match[1] === '-', value: Number(match[2]) * multipliers[match[3]] }
}

function readChunk(fd) {
  const buffer = new Uint8Array(65536)
  const n = read(fd, buffer, -1)
  return n > 0 ? buffer.subarray(0, n) : undefined
}

/** Writes the first `limit` lines or bytes of `fd` as they are read, then stops reading */
function writeFirst(fd, bytesMode, limit) {
  let remaining = limit
  if (remaining === 0) return
  for (;;) {
    const chunk = readChunk(fd)
    if (!chunk) return
    if (bytesMode) {
      const take = Math.min(remaining, chunk.length)
      writeAll(1, chunk.subarray(0, take))
      remaining -= take
    } else {
      let end = 0
      for (let i = 0; i < chunk.length && remaining > 0; i++) {
        if (chunk[i] === NEWLINE) { remaining--; end = i + 1 }
      }
      // A chunk that does not hold the last wanted newline is all wanted
      writeAll(1, chunk.subarray(0, remaining > 0 ? chunk.length : end))
    }
    if (remaining === 0) return
  }
}

/** Writes everything but the last `limit` lines or bytes of `fd`; that needs all of it, so it is read first */
function writeAllButLast(fd, bytesMode, limit) {
  const chunks = []
  let total = 0
  for (let chunk = readChunk(fd); chunk; chunk = readChunk(fd)) { chunks.push(chunk); total += chunk.length }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }

  if (bytesMode) {
    writeAll(1, bytes.subarray(0, Math.max(0, bytes.length - limit)))
    return
  }
  // A last line with no newline is still a line
  let lines = 0
  for (const byte of bytes) if (byte === NEWLINE) lines++
  if (bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE) lines++
  let keep = lines - limit
  if (keep <= 0) return
  let end = 0
  while (keep > 0 && end < bytes.length) { if (bytes[end++] === NEWLINE) keep-- }
  writeAll(1, bytes.subarray(0, end))
}

function main() {
  const args = argv.slice(1)
  let amount = { skipLast: false, value: 10 }
  let bytesMode = false
  let header
  const files = []
  const bad = (what, text) => { err(`invalid number of ${what}: '${text}'`); return 1 }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help' || arg === '-h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
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
      // The obsolete `head -3` spelling of `-n 3`
      amount = { skipLast: false, value: Number(arg.slice(1)) }
      bytesMode = false
    } else if (arg.startsWith('-') && arg !== '-') {
      err(`invalid option -- '${arg.replace(/^-+/, '')}'`)
      err("Try 'head --help' for more information.")
      return 1
    } else files.push(arg)
  }

  const run = fd => (amount.skipLast ? writeAllButLast(fd, bytesMode, amount.value) : writeFirst(fd, bytesMode, amount.value))

  if (files.length === 0) {
    if (header === true) writeAll(1, encoder.encode('==> standard input <==\n'))
    run(0)
    return 0
  }

  const cwd = getcwd()
  const headers = header ?? files.length > 1
  let failed = false
  let printed = false

  for (const file of files) {
    let fd
    let opened = false
    try {
      if (file === '-') fd = 0
      else {
        const fullPath = resolve(cwd, file)
        if (isDirectory(fullPath)) {
          if (headers) writeAll(1, encoder.encode(`${printed ? '\n' : ''}==> ${file} <==\n`))
          printed = true
          err(`error reading '${file}': Is a directory`)
          failed = true
          continue
        }
        fd = open(fullPath, O_RDONLY)
      }
      opened = true
      // The blank line before a header comes from the output before it, not from the file's own last line
      if (headers) writeAll(1, encoder.encode(`${printed ? '\n' : ''}==> ${file === '-' ? 'standard input' : file} <==\n`))
      printed = true
      run(fd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = /ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message
      err(opened ? `error reading '${file}': ${reason}` : `cannot open '${file}' for reading: ${reason}`)
      failed = true
    } finally {
      if (opened && fd > 2) close(fd)
    }
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
