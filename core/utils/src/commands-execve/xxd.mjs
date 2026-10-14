/**
 * Make a hex dump of a file or stdin, as `xxd` does: `-l` stops after that many bytes (so `xxd -l 16 /dev/urandom` returns),
 * `-s` starts at an offset, `-c` sets the bytes per line, `-g` the bytes per group, `-p` prints plain hex and `-u` capitals.
 * The input is dumped as it is read, so an endless one is dumped for ever unless `-l` says where to stop, as on Linux.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: xxd [options] [infile]
Make a hex dump of infile, or of standard input.

  -c cols    format <cols> octets per line (default 16; 30 with -p)
  -g bytes   group <bytes> octets per group (default 2; 0 for no grouping)
  -l len     stop after <len> octets
  -p         plain hex dump, with no offsets or ASCII
  -s seek    start at <seek> bytes into the input
  -u         use upper case hex letters
  -h         display this help and exit`

/** A number as xxd takes it: decimal, `0x` hex or leading-0 octal */
function parseNumber(text) {
  if (text === undefined || !/^(0x[0-9a-f]+|\d+)$/i.test(text)) return undefined
  return /^0x/i.test(text) ? parseInt(text, 16) : /^0\d/.test(text) ? parseInt(text, 8) : parseInt(text, 10)
}

function parseArgs(args) {
  const options = { cols: undefined, group: 2, limit: Infinity, seek: 0, plain: false, upper: false, file: undefined }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    // An option that takes a number accepts it joined (`-l16`) or as the next word (`-l 16`)
    const numeric = (names, set) => {
      const name = names.find(candidate => arg === candidate) ?? names.find(candidate => candidate.length === 2 && arg.startsWith(candidate) && parseNumber(arg.slice(2)) !== undefined)
      if (!name) return false
      const text = arg.length > name.length ? arg.slice(name.length) : args[++i]
      // Like strtol, text that is not a number is 0
      set(parseNumber(text) ?? 0)
      return true
    }
    if (arg === '-h' || arg === '--help') return { help: true }
    if (arg === '-p' || arg === '-ps' || arg === '-postscript' || arg === '-plain') options.plain = true
    else if (arg === '-u') options.upper = true
    else if (numeric(['-c', '-cols'], value => { options.cols = value })) { /* set */ }
    else if (numeric(['-g', '-groupsize'], value => { options.group = value })) { /* set */ }
    else if (numeric(['-l', '-len'], value => { options.limit = value })) { /* set */ }
    else if (numeric(['-s', '-seek'], value => { options.seek = value })) { /* set */ }
    else if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option: ${arg}`)
    else if (options.file === undefined) options.file = arg
    else throw new Error('too many arguments')
  }
  options.cols ??= options.plain ? 30 : 16
  if (options.cols < 1) throw new Error('invalid number of columns')
  return options
}

/** One line of the dump for `bytes` (at most `cols`), starting at `offset` */
function formatLine(bytes, offset, options) {
  const hex = byte => { const text = byte.toString(16).padStart(2, '0'); return options.upper ? text.toUpperCase() : text }
  if (options.plain) return Array.from(bytes, hex).join('') + '\n'

  const { cols, group } = options
  let field = ''
  for (let i = 0; i < bytes.length; i++) {
    if (group > 0 && i > 0 && i % group === 0) field += ' '
    field += hex(bytes[i])
  }
  // The hex field has the width of a full line, so the text lines up on a short last line
  const full = cols * 2 + (group > 0 ? Math.ceil(cols / group) - 1 : 0)
  let text = ''
  for (const byte of bytes) text += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'
  return `${offset.toString(16).padStart(8, '0')}: ${field.padEnd(full)}  ${text}\n`
}

/** Dumps `fd` to stdout line by line as it is read, honouring the seek and the limit */
function dump(fd, options) {
  const { cols, limit } = options
  let toSkip = options.seek
  let remaining = limit
  let offset = options.seek
  let pending = new Uint8Array(0)

  const emit = (final) => {
    let at = 0
    let text = ''
    while (pending.length - at >= cols) {
      text += formatLine(pending.subarray(at, at + cols), offset, options)
      offset += cols
      at += cols
    }
    if (final && pending.length - at > 0) text += formatLine(pending.subarray(at), offset, options)
    pending = pending.slice(at)
    if (text) writeAll(1, encoder.encode(text))
  }

  const buffer = new Uint8Array(65536)
  while (remaining > 0) {
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    let chunk = buffer.subarray(0, n)
    if (toSkip > 0) {
      const drop = Math.min(toSkip, chunk.length)
      toSkip -= drop
      chunk = chunk.subarray(drop)
    }
    if (chunk.length > remaining) chunk = chunk.subarray(0, remaining)
    remaining -= chunk.length
    if (chunk.length === 0) continue
    const joined = new Uint8Array(pending.length + chunk.length)
    joined.set(pending, 0)
    joined.set(chunk, pending.length)
    pending = joined
    emit(false)
  }
  emit(true)
}

function main() {
  let options
  try { options = parseArgs(argv.slice(1)) } catch (error) {
    // Like xxd, a bad option shows the usage
    writeAll(2, encoder.encode(usage + '\n'))
    return 1
  }
  if (options.help) {
    writeAll(1, encoder.encode(usage + '\n'))
    return 0
  }

  const { file } = options
  if (file === undefined || file === '-') {
    dump(0, options)
    return 0
  }

  const fullPath = resolve(getcwd(), file)
  try {
    if (isDirectory(fullPath)) {
      err('xxd: Is a directory')
      return 2
    }
    const fd = open(fullPath, O_RDONLY)
    try { dump(fd, options) } finally { close(fd) }
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = message.includes('ENOENT') ? 'No such file or directory' : message.includes('EACCES') ? 'Permission denied' : message
    err(`xxd: ${file}: ${reason}`)
    // xxd's own status for a file it cannot read
    return 2
  }
}

try {
  exit(main())
} catch (error) {
  writeAll(2, encoder.encode(`xxd: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
