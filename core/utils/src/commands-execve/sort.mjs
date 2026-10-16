/**
 * Sort lines of text files, as GNU `sort` does in the C locale: bytes are compared as they are, so uppercase comes before
 * lowercase. Keys (`-k F[.C][OPTS][,F[.C][OPTS]]`), the field separator (`-t`), and the orderings `-b -d -f -i -g -h -M -n -V -r`,
 * the stable sort `-s`, unique output `-u`, the check `-c`/`-C` and the output file `-o` are supported. When the keys compare
 * equal the whole line decides, unless `-s` or `-u` is given. Numbers are compared as doubles.
 */

import { getopt } from './lib/getopt.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, write, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`sort: ${text}\n`))

const usage = `Usage: sort [OPTION]... [FILE]...
Write sorted concatenation of all FILE(s) to standard output. With no FILE, or when FILE is -, read standard input.

  -b, --ignore-leading-blanks   ignore leading blanks
  -d, --dictionary-order        consider only blanks and alphanumeric characters
  -f, --ignore-case             fold lower case to upper case characters
  -g, --general-numeric-sort    compare according to general numerical value
  -i, --ignore-nonprinting      consider only printable characters
  -M, --month-sort              compare (unknown) < 'JAN' < ... < 'DEC'
  -h, --human-numeric-sort      compare human readable numbers (e.g., 2K 1G)
  -n, --numeric-sort            compare according to string numerical value
  -r, --reverse                 reverse the result of comparisons
  -V, --version-sort            natural sort of (version) numbers within text

  -c, --check, -C               check whether input is sorted; do not sort
  -k, --key=KEYDEF              sort via a key; KEYDEF gives location and type
  -o, --output=FILE             write result to FILE instead of standard output
  -s, --stable                  stabilize sort by disabling last-resort comparison
  -t, --field-separator=SEP     use SEP instead of non-blank to blank transition
  -u, --unique                  with -c, check for strict ordering; without -c, output only the first of an equal run
  -z, --zero-terminated         line delimiter is NUL, not newline
  --help                        display this help and exit

KEYDEF is F[.C][OPTS][,F[.C][OPTS]] for start and stop position, where F is a field number and C a character position in the
field; both are origin 1. OPTS is one or more of [bdfgiMhnRrV], which override global ordering options for that key.`

const longOptions = {
  '--ignore-leading-blanks': 'b', '--dictionary-order': 'd', '--ignore-case': 'f', '--general-numeric-sort': 'g', '--ignore-nonprinting': 'i',
  '--month-sort': 'M', '--human-numeric-sort': 'h', '--numeric-sort': 'n', '--reverse': 'r', '--version-sort': 'V', '--check': 'c',
  '--stable': 's', '--unique': 'u', '--zero-terminated': 'z', '--merge': 'm'
}
const orderingFlags = 'bdfgiMhnRrV'

const isBlank = ch => ch === ' ' || ch === '\t'
const isDigit = ch => ch !== undefined && ch >= '0' && ch <= '9'
const isAlpha = ch => ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))

/** Lines are strings of one character per byte, so comparing them compares bytes */
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

/** `F[.C][OPTS]` of a key, or `undefined` */
function parsePosition(text) {
  const match = /^(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*)$/.exec(text)
  if (!match) return undefined
  return { field: Number(match[1]), char: match[2] === undefined ? undefined : Number(match[2]), flags: new Set(match[3]) }
}

function parseKey(text) {
  const [startText, endText, ...rest] = text.split(',')
  const start = parsePosition(startText)
  const end = endText === undefined ? undefined : parsePosition(endText)
  if (!start || rest.length || (endText !== undefined && !end)) return undefined
  if (start.field === 0 || (end && end.field === 0)) return { error: 'field number is zero: invalid field specification' }
  return { start, end, flags: new Set([...start.flags, ...(end ? end.flags : [])]) }
}

/** [start, end) of the `number`th field (origin 1) of `line` */
function fieldBounds(line, separator, number) {
  if (separator !== undefined) {
    let start = 0
    for (let skipped = 1; skipped < number; skipped++) {
      const next = line.indexOf(separator, start)
      if (next < 0) return [line.length, line.length]
      start = next + 1
    }
    const next = line.indexOf(separator, start)
    return [start, next < 0 ? line.length : next]
  }
  // Without a separator a field is the blanks before a word and the word
  let at = 0
  for (let skipped = 1; skipped < number; skipped++) {
    while (at < line.length && isBlank(line[at])) at++
    while (at < line.length && !isBlank(line[at])) at++
  }
  const start = at
  while (at < line.length && isBlank(line[at])) at++
  while (at < line.length && !isBlank(line[at])) at++
  return [start, at]
}

function keyText(line, key, separator, globalFlags) {
  const flags = key.flags.size ? key.flags : globalFlags
  const blanksAtStart = key.start.flags.size ? key.start.flags.has('b') : flags.has('b')
  let [start] = fieldBounds(line, separator, key.start.field)
  if (blanksAtStart) while (start < line.length && isBlank(line[start])) start++
  start = Math.min(line.length, start + (key.start.char === undefined ? 0 : key.start.char - 1))

  let end = line.length
  if (key.end) {
    const [fieldStart, fieldEnd] = fieldBounds(line, separator, key.end.field)
    if (key.end.char === undefined || key.end.char === 0) end = fieldEnd
    else {
      let from = fieldStart
      const blanksAtEnd = key.end.flags.size ? key.end.flags.has('b') : flags.has('b')
      if (blanksAtEnd) while (from < line.length && isBlank(line[from])) from++
      end = Math.min(fieldEnd, from + key.end.char)
    }
  }
  return end > start ? line.slice(start, end) : ''
}

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const suffixes = 'KMGTPEZY'

/** What a piece of text is compared by, under the ordering flags in effect */
function sortValue(text, flags) {
  if (flags.has('n')) {
    const match = /^[ \t]*(-?)(\d*)(?:\.(\d*))?/.exec(text)
    const digits = match[2] + (match[3] ? '.' + match[3] : '')
    const value = digits === '' || digits === '.' ? 0 : Number(digits)
    return { number: match[1] ? -value : value }
  }
  if (flags.has('h')) {
    const match = /^[ \t]*(-?)(\d*)(?:\.(\d*))?([KMGTPEZYkmgtpezy]?)/.exec(text)
    const digits = match[2] + (match[3] ? '.' + match[3] : '')
    let value = digits === '' || digits === '.' ? 0 : Number(digits)
    const unit = match[4] ? suffixes.indexOf(match[4].toUpperCase()) + 1 : 0
    value *= 1024 ** unit
    return { number: match[1] ? -value : value }
  }
  if (flags.has('g')) {
    const hex = /^[ \t]*([-+]?)0[xX]([0-9a-fA-F]+)(?:\.([0-9a-fA-F]*))?(?:[pP]([-+]?\d+))?/.exec(text)
    if (hex) {
      let value = parseInt(hex[2], 16)
      if (hex[3]) value += parseInt(hex[3], 16) / 16 ** hex[3].length
      if (hex[4]) value *= 2 ** Number(hex[4])
      return { number: hex[1] === '-' ? -value : value }
    }
    const match = /^[ \t]*[-+]?(?:inf(?:inity)?|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/i.exec(text)
    // Text that is not a number sorts before every number
    return { number: match ? Number(match[0].trim().replace(/^\+/, '').replace(/^(-?)inf(inity)?$/i, '$1Infinity')) : -Infinity, text: match ? undefined : text }
  }
  if (flags.has('M')) {
    const word = text.replace(/^[ \t]+/, '').slice(0, 3).toUpperCase()
    return { number: months.indexOf(word) + 1 }
  }
  let value = text
  if (flags.has('d')) value = value.replace(/[^ \t0-9A-Za-z]/g, '')
  if (flags.has('i')) value = value.replace(/[^\x20-\x7e]/g, '')
  if (flags.has('f')) value = value.replace(/[a-z]/g, ch => ch.toUpperCase())
  return { text: value }
}

/** The order of a character in a version string: `~` before the end of the string, then letters, then everything else */
const versionOrder = ch => (ch === undefined ? 0 : isDigit(ch) ? 0 : isAlpha(ch) ? ch.charCodeAt(0) : ch === '~' ? -1 : ch.charCodeAt(0) + 256)

function versionCompare(a, b) {
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    let firstDiff = 0
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const ac = versionOrder(a[i])
      const bc = versionOrder(b[j])
      if (ac !== bc) return ac - bc
      i++
      j++
    }
    while (a[i] === '0') i++
    while (b[j] === '0') j++
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (!firstDiff) firstDiff = a.charCodeAt(i) - b.charCodeAt(j)
      i++
      j++
    }
    if (isDigit(a[i])) return 1
    if (isDigit(b[j])) return -1
    if (firstDiff) return firstDiff
  }
  return 0
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function compareValues(a, b, flags) {
  if (flags.has('V')) return versionCompare(a.raw, b.raw)
  if (a.number !== undefined) {
    if (a.number === b.number || (Number.isNaN(a.number) && Number.isNaN(b.number))) {
      return a.text !== undefined || b.text !== undefined ? compareText(a.text ?? '', b.text ?? '') : 0
    }
    if (Number.isNaN(a.number)) return -1
    if (Number.isNaN(b.number)) return 1
    return a.number < b.number ? -1 : 1
  }
  return compareText(a.text, b.text)
}

function main() {
  const globalFlags = new Set()
  const keys = []
  let separator
  let unique = false
  let stable = false
  let check = false
  let quietCheck = false
  let zero = false
  let merge = false
  let output
  let files0From

  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'bdfgiMhnrRVcCk:mo:sS:t:T:uzy::',
    long: {
      'ignore-leading-blanks': 'b', 'dictionary-order': 'd', 'ignore-case': 'f', 'general-numeric-sort': 'g', 'ignore-nonprinting': 'i',
      'month-sort': 'M', 'human-numeric-sort': 'h', 'numeric-sort': 'n', 'random-sort': 'R', reverse: 'r', 'version-sort': 'V',
      check: { key: 'c', arg: 'optional' }, 'check-only': 'C', key: { key: 'k', arg: 'required' }, merge: 'm', output: { key: 'o', arg: 'required' },
      stable: 's', 'buffer-size': { key: 'S', arg: 'required' }, 'field-separator': { key: 't', arg: 'required' },
      'temporary-directory': { key: 'T', arg: 'required' }, unique: 'u', 'zero-terminated': 'z', sort: { key: 'sort', arg: 'required' },
      parallel: { key: 'parallel', arg: 'required' }, 'batch-size': { key: 'batch', arg: 'required' }, 'compress-program': { key: 'compress', arg: 'required' },
      'random-source': { key: 'source', arg: 'required' }, debug: 'debug', 'files0-from': { key: 'files0', arg: 'required' }, help: 'help', version: 'version'
    }
  })
  if (error) { err(error); err("Try 'sort --help' for more information."); return 2 }
  const sortNames = { 'general-numeric': 'g', 'human-numeric': 'h', month: 'M', numeric: 'n', random: 'R', version: 'V' }
  for (const [flag, value] of options) {
    if (flag === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (flag === 'version') { writeAll(1, encoder.encode('sort (ecmaOS coreutils)\n')); return 0 }
    else if (orderingFlags.includes(flag) && flag.length === 1) globalFlags.add(flag)
    else if (flag === 'u') unique = true
    else if (flag === 's') stable = true
    else if (flag === 'c') { check = true; if (value === 'quiet' || value === 'silent') quietCheck = true }
    else if (flag === 'C') { check = true; quietCheck = true }
    else if (flag === 'z') zero = true
    else if (flag === 'm') merge = true
    else if (flag === 'sort') {
      const names = Object.keys(sortNames)
      const match = names.filter(name => name.startsWith(value))
      if (!match.length || (match.length > 1 && !names.includes(value))) {
        err(`invalid argument ‘${value}’ for ‘--sort’\nValid arguments are:\n${names.map(name => `  - ‘${name}’`).join('\n')}\nTry 'sort --help' for more information.`)
        return 1
      }
      globalFlags.add(sortNames[names.includes(value) ? value : match[0]])
    } else if (flag === 'k') {
      const key = parseKey(value)
      if (!key || key.error) { err(key?.error ? `${key.error} ‘${value}’` : `invalid number at field start: invalid count at start of ‘${value}’`); return 2 }
      keys.push(key)
    } else if (flag === 't') {
      if (value.length > 1 && value !== '\\0') { err(`multi-character tab ‘${value}’`); return 2 }
      separator = value === '\\0' ? '\0' : value
    } else if (flag === 'o') output = value
    else if (flag === 'files0') files0From = value
    // -S, -T, -y, --parallel, --batch-size, --compress-program, --random-source and --debug only tune what the real sort does inside
  }
  const files = [...operands]
  if (files0From !== undefined) {
    try {
      const bytes = files0From === '-' ? readFd(0) : readFd(open(resolve(getcwd(), files0From), O_RDONLY))
      for (const name of decode(bytes).split('\0')) if (name !== '') files.push(name)
    } catch { err(`open failed: ${files0From}: No such file or directory`); return 2 }
  }

  const cwd = getcwd()
  const delimiter = zero ? '\0' : '\n'
  const entries = []
  let readFailed = false

  const add = (text, name, source) => {
    if (text === '') return
    const parts = text.split(delimiter)
    if (parts[parts.length - 1] === '') parts.pop()
    for (const line of parts) entries.push({ line, name, source })
  }

  if (files.length === 0) files.push('-')
  for (const [index, file] of files.entries()) {
    try {
      if (file === '-') { add(decode(readFd(0)), file, index); continue }
      const fullPath = resolve(cwd, file)
      if (isDirectory(fullPath)) { err(`read failed: ${file}: Is a directory`); readFailed = true; continue }
      const fd = open(fullPath, O_RDONLY)
      try { add(decode(readFd(fd)), file, index) } finally { close(fd) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`cannot read: ${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      readFailed = true
    }
  }
  if (readFailed) return 2

  // With no key the whole line is the key, under the global flags
  const keyList = keys.length ? keys : [{ start: { field: 1, flags: new Set() }, whole: true, flags: new Set() }]
  const reverseAll = globalFlags.has('r')

  for (const entry of entries) {
    entry.values = keyList.map(key => {
      const flags = key.flags.size ? key.flags : globalFlags
      const text = key.whole ? entry.line : keyText(entry.line, key, separator, globalFlags)
      const trimmed = flags.has('b') ? text.replace(/^[ \t]+/, '') : text
      const value = sortValue(trimmed, flags)
      value.raw = trimmed
      return value
    })
  }

  const compare = (a, b) => {
    for (let k = 0; k < keyList.length; k++) {
      const flags = keyList[k].flags.size ? keyList[k].flags : globalFlags
      let diff = compareValues(a.values[k], b.values[k], flags)
      if (diff) return flags.has('r') ? -diff : diff
    }
    if (unique || stable) return 0
    const diff = compareText(a.line, b.line)
    return reverseAll ? -diff : diff
  }

  if (check) {
    for (let i = 1; i < entries.length; i++) {
      const diff = compare(entries[i - 1], entries[i])
      if (diff > 0 || (unique && diff === 0)) {
        if (!quietCheck) err(`${entries[i].name}:${i + 1}: disorder: ${entries[i].line}`)
        return 1
      }
    }
    return 0
  }

  if (globalFlags.has('R') && !merge) {
    // a random order: each distinct line gets one random rank, so equal lines stay together
    const ranks = new Map()
    for (const entry of entries) { if (!ranks.has(entry.line)) ranks.set(entry.line, Math.random()) }
    entries.sort((a, b) => ranks.get(a.line) - ranks.get(b.line))
  } else if (merge) {
    // each file is taken to be sorted already: the smallest line at the front of any of them goes next
    const lists = files.map((_, index) => entries.filter(entry => entry.source === index))
    const merged = []
    for (;;) {
      let pick = -1
      for (let f = 0; f < lists.length; f++) {
        if (lists[f].length === 0) continue
        if (pick < 0 || compare(lists[f][0], lists[pick][0]) < 0) pick = f
      }
      if (pick < 0) break
      merged.push(lists[pick].shift())
    }
    entries.length = 0
    entries.push(...merged)
  } else entries.sort(compare)
  const result = []
  for (let i = 0; i < entries.length; i++) {
    if (unique && i > 0 && compare(entries[i - 1], entries[i]) === 0) continue
    result.push(entries[i].line)
  }
  const bytes = encode(result.length ? result.join(delimiter) + delimiter : '')

  if (output !== undefined) {
    try {
      const fd = open(resolve(cwd, output), O_WRONLY | O_CREAT | O_TRUNC, 0o644)
      try { let at = 0; while (at < bytes.length) at += write(fd, bytes.subarray(at), -1) } finally { close(fd) }
    } catch (error) {
      err(`open failed: ${output}: ${error instanceof Error ? error.message : String(error)}`)
      return 2
    }
  } else writeAll(1, bytes)
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
