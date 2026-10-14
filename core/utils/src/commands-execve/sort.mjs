/**
 * Sort lines of text files, as GNU `sort` does in the C locale: bytes are compared as they are, so uppercase comes before
 * lowercase. Keys (`-k F[.C][OPTS][,F[.C][OPTS]]`), the field separator (`-t`), and the orderings `-b -d -f -i -g -h -M -n -V -r`,
 * the stable sort `-s`, unique output `-u`, the check `-c`/`-C` and the output file `-o` are supported. When the keys compare
 * equal the whole line decides, unless `-s` or `-u` is given. Numbers are compared as doubles.
 */

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
  if (start.field === 0) return { error: 'field number is zero: invalid field specification' }
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
  const args = argv.slice(1)
  const globalFlags = new Set()
  const keys = []
  const files = []
  let separator
  let unique = false
  let stable = false
  let check = false
  let quietCheck = false
  let zero = false
  let output

  const needValue = (flag, i, inline) => (inline !== '' ? inline : args[i + 1] === undefined ? (err(`option requires an argument -- '${flag}'`), undefined) : args[i + 1])

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }

    if (arg.startsWith('--')) {
      const [name, value] = arg.split(/=(.*)/s)
      if (longOptions[name]) {
        const flag = longOptions[name]
        if (flag === 'u') unique = true
        else if (flag === 's') stable = true
        else if (flag === 'c') check = true
        else if (flag === 'z') zero = true
        else if (flag === 'm') { /* the same as sorting */ }
        else globalFlags.add(flag)
        continue
      }
      const takes = { '--key': 'k', '--field-separator': 't', '--output': 'o' }[name]
      if (!takes) { err(`unrecognized option '${arg}'`); err("Try 'sort --help' for more information."); return 2 }
      const text = value !== undefined ? value : args[++i]
      if (text === undefined) { err(`option '${name}' requires an argument`); return 2 }
      if (takes === 'k') { const key = parseKey(text); if (!key || key.error) { err(key?.error ?? `invalid field specification '${text}'`); return 2 } keys.push(key) }
      else if (takes === 't') separator = text === '\\0' ? '\0' : text
      else output = text
      continue
    }

    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (orderingFlags.includes(flag)) globalFlags.add(flag)
      else if (flag === 'u') unique = true
      else if (flag === 's') stable = true
      else if (flag === 'c') check = true
      else if (flag === 'C') { check = true; quietCheck = true }
      else if (flag === 'z') zero = true
      else if (flag === 'm') { /* the same as sorting */ }
      else if ('ktoST'.includes(flag)) {
        const text = needValue(flag, i, arg.slice(c + 1))
        if (text === undefined) return 2
        if (arg.slice(c + 1) === '') i++
        if (flag === 'k') { const key = parseKey(text); if (!key || key.error) { err(key?.error ?? `invalid field specification '${text}'`); return 2 } keys.push(key) }
        else if (flag === 't') {
          if (text.length > 1 && text !== '\\0') { err(`multi-character tab '${text}'`); return 2 }
          separator = text === '\\0' ? '\0' : text
        } else if (flag === 'o') output = text
        // -S and -T only tune memory and temporary files
        break
      } else { err(`invalid option -- '${flag}'`); err("Try 'sort --help' for more information."); return 2 }
    }
  }

  const cwd = getcwd()
  const delimiter = zero ? '\0' : '\n'
  const entries = []
  let readFailed = false

  const add = (text, name) => {
    if (text === '') return
    const parts = text.split(delimiter)
    if (parts[parts.length - 1] === '') parts.pop()
    for (const line of parts) entries.push({ line, name })
  }

  if (files.length === 0) files.push('-')
  for (const file of files) {
    try {
      if (file === '-') { add(decode(readFd(0)), file); continue }
      const fullPath = resolve(cwd, file)
      if (isDirectory(fullPath)) { err(`read failed: ${file}: Is a directory`); readFailed = true; continue }
      const fd = open(fullPath, O_RDONLY)
      try { add(decode(readFd(fd)), file) } finally { close(fd) }
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

  entries.sort(compare)
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
