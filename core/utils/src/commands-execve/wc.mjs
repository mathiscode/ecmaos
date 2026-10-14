/**
 * Count lines, words, characters, bytes and the longest line in files or stdin, as GNU `wc` does: the input is counted as it
 * is read, in constant memory, so a very large file works and an endless one (`/dev/zero`) is counted for ever, as on Linux.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, isDirectory, readlink, getpid, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: wc [OPTION]... [FILE]...
Print newline, word, and byte counts for each FILE, and a total line if
more than one FILE is specified. With no FILE, or when FILE is -,
read standard input.

  -c, --bytes            print the byte counts
  -m, --chars            print the character counts
  -l, --lines            print the newline counts
  -L, --max-line-length  print the maximum display width
  -w, --words            print the word counts
      --help             display this help and exit`

const S_IFMT = 0o170000
const S_IFREG = 0o100000

/** The columns, in the order they are printed */
const columns = ['lines', 'words', 'chars', 'bytes', 'longest']
const optionFor = {
  '-l': 'lines', '--lines': 'lines',
  '-w': 'words', '--words': 'words',
  '-m': 'chars', '--chars': 'chars',
  '-c': 'bytes', '--bytes': 'bytes',
  '-L': 'longest', '--max-line-length': 'longest'
}
const letterFor = { l: 'lines', w: 'words', m: 'chars', c: 'bytes', L: 'longest' }

const newCounts = () => ({ lines: 0, words: 0, chars: 0, bytes: 0, longest: 0, inWord: false, width: 0, need: 0 })

/**
 * Adds a chunk of input to the counts. A character is a complete, valid UTF-8 sequence (a stray or truncated byte is not one,
 * as in GNU `wc -m`), and the longest line is in display columns: a tab goes to the next multiple of 8, and a control character
 * takes none.
 */
function countChunk(counts, chunk) {
  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i]
    counts.bytes++

    if (byte === 32 || (byte >= 9 && byte <= 13)) counts.inWord = false
    else if (!counts.inWord) { counts.inWord = true; counts.words++ }

    let completed = false
    if (counts.need > 0) {
      if ((byte & 0xc0) === 0x80) { if (--counts.need === 0) completed = true }
      else counts.need = 0
    }
    if (!completed && counts.need === 0 && (byte & 0xc0) !== 0x80) {
      if (byte < 0x80) completed = true
      else if (byte >= 0xc2 && byte <= 0xdf) counts.need = 1
      else if (byte >= 0xe0 && byte <= 0xef) counts.need = 2
      else if (byte >= 0xf0 && byte <= 0xf4) counts.need = 3
    }

    if (byte === 10 || byte === 13 || byte === 12) {
      if (byte === 10) counts.lines++
      if (completed) counts.chars++
      if (counts.width > counts.longest) counts.longest = counts.width
      counts.width = 0
    } else if (byte === 9) {
      counts.chars++
      counts.width += 8 - (counts.width % 8)
    } else if (completed) {
      counts.chars++
      if (byte >= 0x80 || (byte >= 0x20 && byte !== 0x7f)) counts.width++
    }
  }
}

function countFd(fd) {
  const counts = newCounts()
  const buffer = new Uint8Array(65536)
  for (;;) {
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    countChunk(counts, buffer.subarray(0, n))
  }
  if (counts.width > counts.longest) counts.longest = counts.width
  return counts
}

function countFile(fullPath) {
  const fd = open(fullPath, O_RDONLY)
  try { return countFd(fd) } finally { close(fd) }
}

/** The size of what stdin is redirected from, when that is a regular file; `undefined` for a pipe, terminal or device */
function stdinSize() {
  try {
    const info = stat(readlink(`/proc/${getpid()}/fd/0`))
    return (info.mode & S_IFMT) === S_IFREG ? info.size : undefined
  } catch { return undefined }
}

function main() {
  const args = argv.slice(1)
  const selected = new Set()
  const files = []
  let optionsEnded = false

  for (const arg of args) {
    if (!optionsEnded && arg === '--') optionsEnded = true
    else if (!optionsEnded && (arg === '--help' || arg === '-h')) {
      writeAll(1, encoder.encode(usage + '\n'))
      return 0
    } else if (!optionsEnded && optionFor[arg]) selected.add(optionFor[arg])
    else if (!optionsEnded && arg.startsWith('--')) {
      err(`wc: unrecognized option '${arg}'`)
      err("Try 'wc --help' for more information.")
      return 1
    } else if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      for (const flag of arg.slice(1)) {
        if (!letterFor[flag]) {
          err(`wc: invalid option -- '${flag}'`)
          err("Try 'wc --help' for more information.")
          return 1
        }
        selected.add(letterFor[flag])
      }
    } else files.push(arg)
  }

  if (selected.size === 0) { selected.add('lines'); selected.add('words'); selected.add('bytes') }
  const shown = columns.filter(name => selected.has(name))

  const cwd = getcwd()
  const inputs = files.length ? files : ['-']

  // The number width is that of the sizes of the regular files, and 7 when an input is not one; with a single count of a single
  // input there is nothing to line up, so it is printed bare
  let width = 1
  if (!(shown.length === 1 && inputs.length === 1)) {
    let total = 0
    let minimum = 1
    for (const input of inputs) {
      if (input === '-') {
        const size = stdinSize()
        if (size === undefined) minimum = 7
        else total += size
        continue
      }
      try {
        const info = stat(resolve(cwd, input))
        if ((info.mode & S_IFMT) === S_IFREG) total += info.size
        else minimum = 7
      } catch { /* an input that cannot be examined is reported when it is counted */ }
    }
    width = Math.max(minimum, String(total).length)
  }

  const format = (counts, label) => shown.map(name => String(counts[name]).padStart(width)).join(' ') + (label === undefined ? '' : ` ${label}`) + '\n'

  const total = newCounts()
  let failed = false

  for (const input of inputs) {
    let counts
    try {
      if (input === '-') counts = countFd(0)
      else {
        const fullPath = resolve(cwd, input)
        if (isDirectory(fullPath)) {
          // GNU prints the zero counts, then says what is wrong
          out(format(newCounts(), input))
          err(`wc: ${input}: Is a directory`)
          failed = true
          continue
        }
        counts = countFile(fullPath)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = message.includes('ENOENT') ? 'No such file or directory' : message.includes('EACCES') ? 'Permission denied' : message
      err(`wc: ${input}: ${reason}`)
      failed = true
      continue
    }
    total.lines += counts.lines
    total.words += counts.words
    total.chars += counts.chars
    total.bytes += counts.bytes
    total.longest = Math.max(total.longest, counts.longest)
    out(format(counts, input === '-' && files.length === 0 ? undefined : input))
  }

  if (inputs.length > 1) out(format(total, 'total'))
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, encoder.encode(`wc: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
