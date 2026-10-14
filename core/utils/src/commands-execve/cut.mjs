/**
 * Print selected parts of lines from each file, as GNU `cut` does: bytes (`-b`), characters (`-c`, UTF-8) or delimited fields
 * (`-f` with `-d`), `-s` to leave out lines that have no delimiter, `--complement`, `--output-delimiter` and `-z`. A list is
 * `N`, `N-M`, `N-` and `-M`, separated by commas.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`cut: ${text}\n`))

const usage = `Usage: cut OPTION... [FILE]...
Print selected parts of lines from each FILE to standard output. With no FILE, or when FILE is -, read standard input.

  -b, --bytes=LIST        select only these bytes
  -c, --characters=LIST   select only these characters
  -d, --delimiter=DELIM   use DELIM instead of TAB for field delimiter
  -f, --fields=LIST       select only these fields; also print any line that contains no delimiter character, unless -s
  -n                      (ignored)
      --complement        complement the set of selected bytes, characters or fields
  -s, --only-delimited    do not print lines not containing delimiters
      --output-delimiter=STRING  use STRING as the output delimiter; the default is to use the input delimiter
  -z, --zero-terminated   line delimiter is NUL, not newline
  --help                  display this help and exit

Use one, and only one of -b, -c or -f. Each LIST is made up of one range, or many ranges separated by commas.
Each range is one of: N, N-M, N- (from N to the end of the line), -M (from the first to M).`

/** `1,3-5,-2,7-` as ranges of [from, to] (origin 1, `Infinity` for the end), merged and in order; or an error text */
function parseList(text, what) {
  const ranges = []
  for (const part of text.split(',')) {
    const match = /^(\d*)(-?)(\d*)$/.exec(part)
    if (!match || part === '' || part === '-') return { error: part === '' || part === '-' ? 'invalid range with no endpoint: -' : `invalid ${what} range` }
    const [, from, dash, to] = match
    if (!dash) {
      if (Number(from) === 0) return { error: `${what} are numbered from 1` }
      ranges.push([Number(from), Number(from)])
    } else {
      const low = from === '' ? 1 : Number(from)
      const high = to === '' ? Infinity : Number(to)
      if (from !== '' && low === 0) return { error: `${what} are numbered from 1` }
      if (to !== '' && high === 0) return { error: `${what} are numbered from 1` }
      if (low > high) return { error: 'invalid decreasing range' }
      ranges.push([low, high])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }
  return { ranges: merged }
}

const decode = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }
const encode = text => Uint8Array.from(text, ch => ch.charCodeAt(0))

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

/** A line (a string of one character per byte) as its UTF-8 characters, each still as bytes; a byte that is not part of one is a character of its own */
function characters(line) {
  const out = []
  for (let i = 0; i < line.length;) {
    const byte = line.charCodeAt(i)
    const length = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc2 && byte < 0xe0 ? 2 : 1
    let ok = length > 1 && i + length <= line.length
    for (let k = 1; ok && k < length; k++) if ((line.charCodeAt(i + k) & 0xc0) !== 0x80) ok = false
    const size = ok ? length : 1
    out.push(line.slice(i, i + size))
    i += size
  }
  return out
}

function main() {
  const args = argv.slice(1)
  let mode
  let list
  let delimiter = '\t'
  let delimiterGiven = false
  let outputDelimiter
  let onlyDelimited = false
  let complement = false
  let zero = false
  const files = []

  const setMode = (kind, value) => {
    if (mode && mode !== kind) { err('only one type of list may be specified'); err("Try 'cut --help' for more information."); return false }
    mode = kind
    list = value
    return true
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }

    if (arg.startsWith('--')) {
      const [name, inline] = arg.split(/=(.*)/s)
      const value = () => (inline !== undefined ? inline : args[++i])
      if (name === '--bytes') { if (!setMode('b', value())) return 1 }
      else if (name === '--characters') { if (!setMode('c', value())) return 1 }
      else if (name === '--fields') { if (!setMode('f', value())) return 1 }
      else if (name === '--delimiter') { delimiter = value(); delimiterGiven = true }
      else if (name === '--output-delimiter') outputDelimiter = value()
      else if (name === '--only-delimited') onlyDelimited = true
      else if (name === '--complement') complement = true
      else if (name === '--zero-terminated') zero = true
      else { err(`unrecognized option '${arg}'`); err("Try 'cut --help' for more information."); return 1 }
      continue
    }

    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if ('bcfd'.includes(flag)) {
        const value = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]
        if (value === undefined) { err(`option requires an argument -- '${flag}'`); err("Try 'cut --help' for more information."); return 1 }
        if (flag === 'd') { delimiter = value; delimiterGiven = true }
        else if (!setMode(flag, value)) return 1
        break
      }
      if (flag === 's') onlyDelimited = true
      else if (flag === 'z') zero = true
      else if (flag === 'n') { /* ignored */ }
      else { err(`invalid option -- '${flag}'`); err("Try 'cut --help' for more information."); return 1 }
    }
  }

  if (!mode) { err('you must specify a list of bytes, characters, or fields'); err("Try 'cut --help' for more information."); return 1 }
  if (delimiter.length !== 1) { err('the delimiter must be a single character'); err("Try 'cut --help' for more information."); return 1 }
  if (mode !== 'f' && delimiterGiven) {
    err('an input delimiter may be specified only when operating on fields'); err("Try 'cut --help' for more information."); return 1
  }
  if (mode !== 'f' && onlyDelimited) { err('suppressing non-delimited lines makes sense\n\tonly when operating on fields'); err("Try 'cut --help' for more information."); return 1 }

  const parsed = parseList(list, mode === 'f' ? 'fields' : mode === 'b' ? 'byte positions' : 'character positions')
  if (parsed.error) { err(parsed.error); err("Try 'cut --help' for more information."); return 1 }
  const { ranges } = parsed

  const lineEnd = zero ? '\0' : '\n'
  const joiner = outputDelimiter !== undefined ? outputDelimiter : delimiter

  /** The selected positions of `items` (1-based, in ranges or their complement), kept as the ranges that cover them */
  const select = items => {
    const groups = []
    const has = index => ranges.some(([from, to]) => index >= from && index <= to)
    for (let n = 1; n <= items.length; n++) {
      if (has(n) === complement) continue
      const last = groups[groups.length - 1]
      if (last && last.end === n - 1) { last.items.push(items[n - 1]); last.end = n }
      else groups.push({ end: n, items: [items[n - 1]] })
    }
    return groups
  }

  const cutLine = line => {
    if (mode === 'f') {
      if (!line.includes(delimiter)) return onlyDelimited ? undefined : line
      const fields = line.split(delimiter)
      const picked = select(fields).flatMap(group => group.items)
      return picked.join(joiner)
    }
    const items = mode === 'b' ? [...line] : characters(line)
    const groups = select(items)
    // Between separate ranges there is the output delimiter, when one was given
    return groups.map(group => group.items.join('')).join(outputDelimiter ?? '')
  }

  const cwd = getcwd()
  let failed = false

  const handle = text => {
    if (text === '') return
    const lines = text.split(lineEnd)
    if (lines[lines.length - 1] === '') lines.pop()
    let out = ''
    for (const line of lines) {
      const cut = cutLine(line)
      if (cut !== undefined) out += cut + lineEnd
    }
    writeAll(1, encode(out))
  }

  if (files.length === 0) files.push('-')
  for (const file of files) {
    try {
      if (file === '-') { handle(decode(readFd(0))); continue }
      const fullPath = resolve(cwd, file)
      if (isDirectory(fullPath)) { err(`${file}: Is a directory`); failed = true; continue }
      const fd = open(fullPath, O_RDONLY)
      try { handle(decode(readFd(fd))) } finally { close(fd) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      failed = true
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
