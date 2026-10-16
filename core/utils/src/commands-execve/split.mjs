/**
 * Split a file into pieces, as GNU `split` does: by lines (`-l`, the default of 1000), by bytes (`-b`), by lines
 * limited to a byte count (`-C`) or into a number of chunks (`-n N`, `K/N`, `l/N`, `l/K/N`, `r/N`, `r/K/N`). Pieces
 * are named PREFIX plus a suffix (`aa`, `ab`; `-d` digits, `-x` hex; `-a` sets the length; `--additional-suffix`
 * follows it) and are written to the current directory, not the input's.
 */

import { resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'
import { parseSize } from './lib/size.mjs'

const { argv, exit, writeAll, getcwd, open, close, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`split: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('split') + '\n'))

const usage = `Usage: split [OPTION]... [FILE [PREFIX]]
Output pieces of FILE to PREFIXaa, PREFIXab, ...;
default size is 1000 lines, and default PREFIX is 'x'.

With no FILE, or when FILE is -, read standard input.

Mandatory arguments to long options are mandatory for short options too.
  -a, --suffix-length=N   generate suffixes of length N (default 2)
      --additional-suffix=SUFFIX  append an additional SUFFIX to file names
  -b, --bytes=SIZE        put SIZE bytes per output file
  -C, --line-bytes=SIZE   put at most SIZE bytes of records per output file
  -d                      use numeric suffixes starting at 0, not alphabetic
      --numeric-suffixes[=FROM]  same as -d, but allow setting the start value
  -x                      use hex suffixes starting at 0, not alphabetic
      --hex-suffixes[=FROM]  same as -x, but allow setting the start value
  -e, --elide-empty-files  do not generate empty output files with '-n'
      --filter=COMMAND    write to shell COMMAND; file name is $FILE
  -l, --lines=NUMBER      put NUMBER lines/records per output file
  -n, --number=CHUNKS     generate CHUNKS output files; see explanation below
  -t, --separator=SEP     use SEP instead of newline as the record separator;
                            '\\0' (zero) specifies the NUL character
  -u, --unbuffered        immediately copy input to output with '-n r/...'
      --verbose           print a diagnostic just before each
                            output file is opened
      --help        display this help and exit
      --version     output version information and exit

The SIZE argument is an integer and optional unit (example: 10K is 10*1024).
Units are K,M,G,T,P,E,Z,Y,R,Q (powers of 1024) or KB,MB,... (powers of 1000).
Binary prefixes can be used, too: KiB=K, MiB=M, and so on.

CHUNKS may be:
  N       split into N files based on size of input
  K/N     output Kth of N to stdout
  l/N     split into N files without splitting lines/records
  l/K/N   output Kth of N to stdout without splitting lines/records
  r/N     like 'l' but use round robin distribution
  r/K/N   likewise but only output Kth of N to stdout
`

const quote = text => `‘${text}’`

const ALPHABETS = { alpha: 'abcdefghijklmnopqrstuvwxyz', digit: '0123456789', hex: '0123456789abcdef' }

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: '0123456789a:b:C:dxel:n:t:u',
    long: {
      'suffix-length': { key: 'a', arg: 'required' }, 'additional-suffix': { key: 'S', arg: 'required' },
      bytes: { key: 'b', arg: 'required' }, 'line-bytes': { key: 'C', arg: 'required' },
      'numeric-suffixes': { key: 'N', arg: 'optional' }, 'hex-suffixes': { key: 'X', arg: 'optional' },
      'elide-empty-files': 'e', filter: { key: 'F', arg: 'required' }, lines: { key: 'l', arg: 'required' },
      number: { key: 'n', arg: 'required' }, separator: { key: 't', arg: 'required' }, unbuffered: 'u',
      verbose: 'v', help: 'help', version: 'version'
    }
  })
  if (error) { err(error); hint(); return 1 }

  const s = {
    suffixLength: undefined, additional: '', mode: undefined, amount: 0, alphabet: ALPHABETS.alpha, start: 0, elide: false,
    verbose: false, separator: 10, chunks: undefined
  }
  let digitsLines
  for (const [key, value] of options) {
    switch (key) {
      case 'help': out(usage); return 0
      case 'version': out('split (ecmaOS coreutils) 1.0\n'); return 0
      case 'a': {
        if (!/^\d+$/.test(String(value))) { err(`invalid suffix length: ${quote(value)}`); return 1 }
        s.suffixLength = Number(value)
        if (s.suffixLength === 0) { err(`invalid suffix length: ${quote(value)}`); return 1 }
        break
      }
      case 'S':
        if (String(value).includes('/')) { err(`invalid suffix ${quote(value)}, contains directory separator`); return 1 }
        s.additional = String(value)
        break
      case 'b': {
        const size = parseSize(String(value))
        if (size === undefined || size <= 0) { err(`invalid number of bytes: ${quote(value)}`); return 1 }
        s.mode = 'bytes'; s.amount = size
        break
      }
      case 'C': {
        const size = parseSize(String(value))
        if (size === undefined || size <= 0) { err(`invalid number of bytes: ${quote(value)}`); return 1 }
        s.mode = 'linebytes'; s.amount = size
        break
      }
      case 'l': {
        if (!/^\d+$/.test(String(value)) || Number(value) <= 0) { err(`invalid number of lines: ${quote(value)}`); return 1 }
        s.mode = 'lines'; s.amount = Number(value)
        break
      }
      case 'n': {
        const match = /^(?:(l|r)\/)?(?:(\d+)\/)?(\d+)$/.exec(String(value))
        if (!match || Number(match[3]) <= 0 || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > Number(match[3])))) {
          err(`invalid number of chunks: ${quote(value)}`)
          return 1
        }
        s.mode = 'chunks'
        s.chunks = { kind: match[1] ?? 'b', k: match[2] === undefined ? undefined : Number(match[2]), n: Number(match[3]) }
        break
      }
      case 'd': s.alphabet = ALPHABETS.digit; break
      case 'N':
        s.alphabet = ALPHABETS.digit
        if (value !== true) {
          if (!/^\d+$/.test(String(value))) { err(`invalid start value ${quote(value)}`); return 1 }
          s.start = Number(value)
        }
        break
      case 'x': s.alphabet = ALPHABETS.hex; break
      case 'X':
        s.alphabet = ALPHABETS.hex
        if (value !== true) {
          if (!/^[0-9a-fA-F]+$/.test(String(value))) { err(`invalid start value ${quote(value)}`); return 1 }
          s.start = parseInt(String(value), 16)
        }
        break
      case 'e': s.elide = true; break
      case 'F': err('--filter is not supported'); return 1
      case 't': {
        const text = String(value) === '\\0' ? '\0' : String(value)
        if (text.length !== 1) { err('multi-character separator ' + quote(value)); return 1 }
        s.separator = text.charCodeAt(0)
        break
      }
      case 'v': s.verbose = true; break
      case 'u': break
      default:
        // -NUMBER is -l NUMBER
        if (/^\d$/.test(key)) { digitsLines = (digitsLines ?? '') + key; s.mode = 'lines'; s.amount = Number(digitsLines) }
    }
  }
  if (s.mode === undefined) { s.mode = 'lines'; s.amount = 1000 }
  if (operands.length > 2) { err(`extra operand ${quote(operands[2])}`); hint(); return 1 }
  const input = operands[0] ?? '-'
  const prefix = operands[1] ?? 'x'
  const suffixLength = s.suffixLength ?? 2

  // Names, in order
  const base = s.alphabet.length
  // Without -a a suffix grows when it runs out, as in GNU: after the last name of length N (the first character is
  // never the alphabet's last one) come names that start with that last character and have N+1 characters, and so on.
  // With -a, or with -n, the length is fixed and the names end at `capacity`.
  const widening = s.suffixLength === undefined && s.mode !== 'chunks'
  const capacity = widening ? Infinity : base ** suffixLength
  const nameOf = index => {
    let value = index + s.start
    let level = 0
    let width = suffixLength
    if (widening) {
      for (;;) {
        const size = (base - 1) * base ** (width - 1)
        if (value < size) break
        value -= size
        level++
        width++
      }
    }
    let text = ''
    for (let i = 0; i < width; i++) { text = s.alphabet[value % base] + text; value = Math.floor(value / base) }
    return prefix + s.alphabet[base - 1].repeat(level) + text + s.additional
  }

  const cwd = getcwd()
  let data
  try {
    data = input === '-' ? readFdBytes(0) : readFileBytes(resolve(cwd, input))
  } catch (e) {
    err(`cannot open ${quote(input)} for reading: ${reasonOf(e)}`)
    return 1
  }

  let counter = 0
  let failed = false
  const write = (name, bytes) => {
    if (s.verbose) out(`creating file '${name}'\n`)
    try {
      const fd = open(resolve(cwd, name), O_WRONLY | O_CREAT | O_TRUNC, 0o666)
      try { if (bytes.length) writeAll(fd, bytes) } finally { close(fd) }
    } catch (e) {
      err(`${name}: ${reasonOf(e)}`)
      failed = true
    }
  }
  const emit = bytes => {
    if (counter + s.start >= capacity) { err('output file suffixes exhausted'); throw new Error('exhausted') }
    write(nameOf(counter++), bytes)
  }

  const sep = s.separator
  const total = data.length

  if (s.mode === 'bytes') {
    for (let at = 0; at < total; at += s.amount) emit(data.subarray(at, Math.min(total, at + s.amount)))
  } else if (s.mode === 'lines') {
    let begin = 0
    let seen = 0
    for (let i = 0; i < total; i++) {
      if (data[i] !== sep) continue
      seen++
      if (seen === s.amount) { emit(data.subarray(begin, i + 1)); begin = i + 1; seen = 0 }
    }
    if (begin < total) emit(data.subarray(begin))
  } else if (s.mode === 'linebytes') {
    let begin = 0
    let lineStart = 0
    const limit = s.amount
    for (let i = 0; i < total; i++) {
      if (data[i] !== sep && i !== total - 1) continue
      const lineEnd = i + 1
      if (lineEnd - lineStart > limit) {
        // the line does not fit in an empty piece: flush what is pending, then cut the line into limit-sized parts
        if (lineStart > begin) { emit(data.subarray(begin, lineStart)); begin = lineStart }
        let at = lineStart
        while (lineEnd - at > limit) { emit(data.subarray(at, at + limit)); at += limit }
        begin = at
        lineStart = lineEnd
        continue
      }
      if (lineEnd - begin > limit) { emit(data.subarray(begin, lineStart)); begin = lineStart }
      lineStart = lineEnd
    }
    if (begin < total) emit(data.subarray(begin))
  } else {
    const { kind, k, n } = s.chunks
    const pieces = Array.from({ length: n }, () => [])
    if (kind === 'b') {
      const size = Math.floor(total / n)
      const extra = total % n
      let at = 0
      for (let i = 0; i < n; i++) {
        const length = size + (i < extra ? 1 : 0)
        pieces[i].push(data.subarray(at, at + length))
        at += length
      }
    } else if (kind === 'l') {
      const size = Math.floor(total / n)
      const extra = total % n
      const ends = []
      let at = 0
      for (let i = 0; i < n; i++) { at += size + (i < extra ? 1 : 0); ends.push(at) }
      let chunk = 0
      let begin = 0
      for (let i = 0; i < total; i++) {
        if (data[i] !== sep && i !== total - 1) continue
        while (chunk < n - 1 && begin >= ends[chunk]) chunk++
        pieces[chunk].push(data.subarray(begin, i + 1))
        begin = i + 1
      }
    } else {
      let line = 0
      let begin = 0
      for (let i = 0; i < total; i++) {
        if (data[i] !== sep && i !== total - 1) continue
        pieces[line % n].push(data.subarray(begin, i + 1))
        line++
        begin = i + 1
      }
    }
    const join = list => {
      const length = list.reduce((sum, part) => sum + part.length, 0)
      const bytes = new Uint8Array(length)
      let at = 0
      for (const part of list) { bytes.set(part, at); at += part.length }
      return bytes
    }
    if (k !== undefined) {
      const bytes = join(pieces[k - 1])
      if (bytes.length) writeAll(1, bytes)
    } else {
      for (let i = 0; i < n; i++) {
        const bytes = join(pieces[i])
        if (bytes.length === 0 && s.elide) continue
        emit(bytes)
      }
    }
  }
  return failed ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  if (error?.message !== 'exhausted') err(error instanceof Error ? error.message : String(error))
  exit(1)
}
