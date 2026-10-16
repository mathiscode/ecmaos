/**
 * `pr` as GNU coreutils has it: pages of 66 lines with a five-line header and trailer, `-COLUMNS` (down), `-a` (across) and
 * `-m` (files side by side), `-t`/`-T`, `-n`/`-N`, `-o`, `-d`, `-e`/`-i`, `-s`/`-S`/`-J`, `-w`/`-W`, `-c`/`-v` and `+FIRST[:LAST]`.
 *
 * Text is handled as bytes (one character per byte, as GNU pr does); `host.readFile(name)` and `host.readStdin()` give the
 * content as a latin1 string and `host.now()` the time for the header date of standard input.
 */

import { strftime } from './strftime.mjs'
import { quotef } from './errno.mjs'

export const PR_USAGE = `Usage: pr [OPTION]... [FILE]...
Paginate or columnate FILE(s) for printing.

With no FILE, or when FILE is -, read standard input.

Mandatory arguments to long options are mandatory for short options too.

  +FIRST_PAGE[:LAST_PAGE], --pages=FIRST_PAGE[:LAST_PAGE]
         begin [stop] printing with page FIRST_[LAST_]PAGE
  -COLS, --columns=COLS
         output COLS columns and print columns down, unless -a is used.
         Balance number of lines in the columns on each page
  -a, --across
         print columns across rather than down, used together with -COLS
  -c, --show-control-chars
         use hat notation (^G) and octal backslash notation
  -d, --double-space
         double space the output
  -D, --date-format=FORMAT
         use FORMAT for the header date
  -e[CHAR[WIDTH]], --expand-tabs[=CHAR[WIDTH]]
         expand input CHARs (TABs) to tab WIDTH (8)
  -F, -f, --form-feed
         use form feeds instead of newlines to separate pages
         (by a 3-line page header with -F or a 5-line header
         and trailer without -F)
  -h, --header=HEADER
         use a centered HEADER instead of filename in page header,
         -h "" prints a blank line, don't use -h""
  -i[CHAR[WIDTH]], --output-tabs[=CHAR[WIDTH]]
         replace spaces with CHARs (TABs) to tab WIDTH (8)
  -J, --join-lines
         merge full lines, turns off -W line truncation,
         no column alignment, --sep-string[=STRING] sets separators
  -l, --length=PAGE_LENGTH
         set the page length to PAGE_LENGTH (66) lines
         (default number of lines of text 56, and with -F 63).
         implies -t if PAGE_LENGTH <= 10
  -m, --merge
         print all files in parallel, one in each column,
         truncate lines, but join lines of full length with -J
  -n[SEP[DIGITS]], --number-lines[=SEP[DIGITS]]
         number lines, use DIGITS (5) digits, then SEP (TAB),
         default counting starts with 1st line of input file
  -N, --first-line-number=NUMBER
         start counting with NUMBER at 1st line of first
         page printed (see +FIRST_PAGE)
  -o, --indent=MARGIN
         offset each line with MARGIN (zero) spaces, do not
         affect -w or -W, MARGIN will be added to PAGE_WIDTH
  -r, --no-file-warnings
         omit warning when a file cannot be opened
  -s[CHAR], --separator[=CHAR]
         separate columns by a single character, default for CHAR
         is the <TAB> character without -w and 'no char' with -w.
         -s[CHAR] turns off line truncation of all 3 column
         options (-COLS|-a -COLS|-m) except -w is set
  -S[STRING], --sep-string[=STRING]
         separate columns by STRING,
         without -S: Default separator <TAB> with -J and <space>
         otherwise (same as -S" "), no effect on column options
  -t, --omit-header
         omit page headers and trailers; implied if PAGE_LENGTH <= 10
  -T, --omit-pagination
         omit page headers and trailers,
         eliminate any pagination by form feeds set in input files
  -v, --show-nonprinting
         use octal backslash notation
  -w, --width=PAGE_WIDTH
         set page width to PAGE_WIDTH (72) characters for
         multiple text-column output only, -s[char] turns off (72)
  -W, --page-width=PAGE_WIDTH
         set page width to PAGE_WIDTH (72) characters always,
         truncate lines, except -J option is set,
         no interference with -S or -s
      --help
         display this help and exit
      --version
         output version information and exit`

const SHORT = 'acdD:e::fFh:i::Jl:mn::N:o:rs::S::tTvw:W:'
const LONG = {
  across: 'a', 'show-control-chars': 'c', 'double-space': 'd', 'date-format': { key: 'D', arg: 'required' },
  'expand-tabs': { key: 'e', arg: 'optional' }, 'form-feed': 'F', header: { key: 'h', arg: 'required' },
  'output-tabs': { key: 'i', arg: 'optional' }, 'join-lines': 'J', length: { key: 'l', arg: 'required' }, merge: 'm',
  'number-lines': { key: 'n', arg: 'optional' }, 'first-line-number': { key: 'N', arg: 'required' },
  indent: { key: 'o', arg: 'required' }, 'no-file-warnings': 'r', separator: { key: 's', arg: 'optional' },
  'sep-string': { key: 'S', arg: 'optional' }, 'omit-header': 't', 'omit-pagination': 'T', 'show-nonprinting': 'v',
  width: { key: 'w', arg: 'required' }, 'page-width': { key: 'W', arg: 'required' }, pages: { key: 'pages', arg: 'required' },
  columns: { key: 'columns', arg: 'required' }, help: 'help', version: 'version'
}

const INT_MAX = 2147483647
const q = text => `‘${text}’`
const quote = text => `'${text}'`

/** Digits of `text` as a number, or `undefined` when it is not a plain unsigned number */
function number(text) {
  return /^\d+$/.test(text) ? Number(text) : undefined
}

/** `-e`, `-i` and `-n` take an optional `[CHAR[WIDTH]]`: a non-digit first character is the CHAR, the rest the WIDTH */
function charAndWidth(text, flag, label, defaults) {
  if (text === true || text === '') return { char: defaults.char, width: defaults.width }
  let char = defaults.char
  let rest = text
  if (!/^\d/.test(text)) { char = text[0]; rest = text.slice(1) }
  if (rest === '') return { char, width: defaults.width }
  const width = number(rest)
  if (width === undefined || width === 0 || width > INT_MAX) return { error: `'-${flag}${label}' extra characters or invalid number in the argument: ${q(text)}` }
  return { char, width }
}

/** Splits `args` into the options pr's getopt sees: `-12` becomes `--columns=12`, `+3:5` becomes `--pages=3:5` */
function normalize(args) {
  const result = []
  let afterOptions = false
  let digits = -1
  for (const arg of args) {
    if (afterOptions) { result.push(arg); continue }
    if (arg === '--') { afterOptions = true; result.push(arg); digits = -1; continue }
    const columns = /^-(\d+)(.*)$/.exec(arg)
    if (columns && !arg.startsWith('--')) {
      // digits in consecutive options go on a single number: -1 -2 is 12 columns
      if (digits >= 0 && !columns[2]) result[digits] = `${result[digits]}${columns[1]}`
      else { digits = result.length; result.push(`--columns=${columns[1]}`) }
      if (columns[2]) { result.push(`-${columns[2]}`); digits = -1 }
    } else { result.push(arg); digits = -1 }
  }
  return result
}

export function parseArgs(args, getopt) {
  const pages = []
  const rest = []
  let plusSeen = false
  for (const arg of normalize(args)) {
    if (arg === '--pages' || arg.startsWith('--pages=')) plusSeen = true
    if (!plusSeen && arg.startsWith('+') && arg.length > 1) {
      const m = /^\+(\d+)(?::(\d+))?$/.exec(arg)
      if (!m) return { error: `invalid + argument ${quote(arg.slice(1))}` }
      const first = Number(m[1])
      const last = m[2] === undefined ? Infinity : Number(m[2])
      if (first === 0 || last < first) { rest.push(arg); plusSeen = true; continue }
      pages.push({ first, last })
      plusSeen = true
    } else rest.push(arg)
  }
  const { options, operands, error } = getopt(rest, { short: SHORT, long: LONG })
  if (error) return { error, usage: true }
  const o = {
    columns: 1, columnsGiven: false, across: false, merge: false, controlChars: false, nonprinting: false, double: false,
    dateFormat: undefined, expand: undefined, output: undefined, formFeed: false, header: undefined, join: false, length: 66,
    number: undefined, firstNumber: undefined, indent: 0, ignoreOpen: false, sepKind: undefined, sepString: undefined,
    omitHeader: false, omitPagination: false, width: 72, widthKind: undefined, firstPage: 1, lastPage: Infinity, files: operands
  }
  const fail = message => ({ error: message })
  for (const [key, value] of options) {
    switch (key) {
      case 'help': return { help: true }
      case 'version': return { version: true }
      case 'a': o.across = true; break
      case 'c': o.controlChars = true; break
      case 'd': o.double = true; break
      case 'D': o.dateFormat = value; break
      case 'e': {
        const r = charAndWidth(value, 'e', '[CHAR[WIDTH]]', o.expand ?? { char: '\t', width: 8 })
        if (r.error) return fail(r.error)
        o.expand = r
        break
      }
      case 'f': case 'F': o.formFeed = true; break
      case 'h': o.header = value; break
      case 'i': {
        const r = charAndWidth(value, 'i', '[CHAR[WIDTH]]', o.output ?? { char: '\t', width: 8 })
        if (r.error) return fail(r.error)
        o.output = r
        break
      }
      case 'J': o.join = true; break
      case 'l': {
        const n = number(value)
        if (n === undefined) return fail(`'-l PAGE_LENGTH' invalid number of lines: ${q(value)}`)
        if (n === 0 || n > INT_MAX) return fail(`'-l PAGE_LENGTH' invalid number of lines: ${q(value)}: Numerical result out of range`)
        o.length = n
        break
      }
      case 'm': o.merge = true; break
      case 'n': {
        const previous = o.number ?? { char: '\t', digits: 5 }
        if (value === true) { o.number = previous; break }
        let char = previous.char
        let digits = value
        if (!/^\d/.test(value)) { char = value[0]; digits = value.slice(1) }
        let width = previous.digits
        if (digits !== '') {
          width = number(digits)
          if (width === undefined || width === 0 || width > INT_MAX) return fail(`'-n[SEP[DIGITS]]' extra characters or invalid number in the argument: ${q(value)}`)
        }
        o.number = { char, digits: width }
        break
      }
      case 'N': {
        if (!/^-?\d+$/.test(value)) return fail(`'-N NUMBER' invalid starting line number: ${q(value)}`)
        o.firstNumber = Number(value)
        break
      }
      case 'o': {
        const n = number(value)
        if (n === undefined) return fail(`'-o MARGIN' invalid line offset: ${q(value)}${/^-\d+$/.test(value) ? ': Value too large for defined data type' : ''}`)
        if (n > INT_MAX) return fail(`'-o MARGIN' invalid line offset: ${q(value)}: Value too large for defined data type`)
        o.indent = n
        break
      }
      case 'r': o.ignoreOpen = true; break
      case 's': if (o.sepKind !== 'S') { o.sepKind = 's'; o.sepString = value === true ? undefined : value } break
      case 'S': o.sepKind = 'S'; o.sepString = value === true ? '' : value; break
      case 't': o.omitHeader = true; break
      case 'T': o.omitHeader = true; o.omitPagination = true; break
      case 'v': o.nonprinting = true; break
      case 'w': case 'W': {
        const n = number(value)
        if (n === undefined) return fail(`'-${key} PAGE_WIDTH' invalid number of characters: ${q(value)}`)
        if (n === 0 || n > INT_MAX) return fail(`'-${key} PAGE_WIDTH' invalid number of characters: ${q(value)}: Numerical result out of range`)
        if (key === 'W' || o.widthKind !== 'W') { o.width = n; o.widthKind = key }
        break
      }
      case 'columns': {
        const n = number(value)
        if (n === undefined) return fail(`invalid number of columns: ${q(value)}`)
        if (n === 0 || n > INT_MAX) return fail(`invalid number of columns: ${q(value)}: Numerical result out of range`)
        o.columns = n
        o.columnsGiven = true
        break
      }
      case 'pages': {
        const m = /^(\d+)(?::(\d+))?$/.exec(value)
        if (!m) return fail(/^\d+:\d+:/.test(value) ? `invalid suffix in --pages argument ${quote(value)}` : `invalid --pages argument ${quote(value)}`)
        const first = Number(m[1])
        const last = m[2] === undefined ? Infinity : Number(m[2])
        if (first === 0 || last < first) return fail(`invalid page range ${q(value)}`)
        pages.push({ first, last })
        break
      }
    }
  }
  for (const range of pages) {
    o.firstPage = range.first
    o.lastPage = range.last
  }
  return { options: o }
}

const spaces = n => (n > 0 ? ' '.repeat(n) : '')

/** Spaces to move from column `from` to column `to`: a run of two or more uses tabs (char `tab` every `width` columns) up to `to` */
function pad(from, to, tab) {
  let out = ''
  let at = from
  if (tab && to - from >= 2) {
    for (;;) {
      const stop = (Math.floor(at / tab.width) + 1) * tab.width
      if (stop > to) break
      out += tab.char
      at = stop
    }
  }
  return out + spaces(to - at)
}

/** A line of text turned into its output form: tabs, control characters, and its width in columns */
function prepare(text, o, limit, expandTabs) {
  let out = ''
  let pos = 0
  const expandChar = o.expand ? o.expand.char : undefined
  const expandWidth = o.expand ? o.expand.width : 8
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const c = text.charCodeAt(i)
    let piece
    let width
    if (o.expand && ch === expandChar) {
      width = expandWidth - (pos % expandWidth)
      piece = spaces(width)
    } else if ((o.expand || expandTabs) && ch === '\t') {
      width = 8 - (pos % 8)
      piece = spaces(width)
    } else if (ch === '\t') {
      width = 8 - (pos % 8)
      piece = ch
    } else if (c === 8) {
      width = pos > 0 ? -1 : 0
      piece = ch
    } else if (c === 13) {
      width = -pos
      piece = ch
    } else if (c >= 32 && c < 127) {
      width = 1
      piece = ch
    } else if (o.nonprinting || (o.controlChars && c >= 128)) {
      piece = `\\${c.toString(8).padStart(3, '0')}`
      width = 4
    } else if (o.controlChars) {
      piece = `^${String.fromCharCode(c ^ 0x40)}`
      width = 2
    } else {
      width = 0
      piece = ch
    }
    if (limit !== undefined && pos + width > limit && width > 0) break
    out += piece
    pos += width
  }
  return { text: out, width: pos }
}

/** Runs of two or more spaces become tabs where they reach a tab stop of `-i` */
function tabify(text, tab, start = 0) {
  if (!tab) return text
  let out = ''
  let pos = start
  for (let i = 0; i < text.length;) {
    if (text[i] !== ' ') {
      const c = text.charCodeAt(i)
      out += text[i]
      pos = text[i] === '\t' ? (Math.floor(pos / 8) + 1) * 8 : c === 8 ? Math.max(0, pos - 1) : c === 13 ? 0 : c >= 32 && c < 127 ? pos + 1 : pos
      i++
      continue
    }
    let run = 0
    while (text[i + run] === ' ') run++
    out += pad(pos, pos + run, tab)
    pos += run
    i += run
  }
  return out
}

/** Reads the lines of a file: `{ text, newline }` entries and `{ formFeed: true }` markers */
function lineItems(content, o) {
  const items = []
  if (content === '') return items
  let start = 0
  const length = content.length
  while (start < length) {
    let end = content.indexOf('\n', start)
    const hasNewline = end !== -1
    if (!hasNewline) end = length
    const text = content.slice(start, end)
    if (!o.omitPagination && text.includes('\f')) {
      const parts = text.split('\f')
      parts.forEach((part, index) => {
        if (index > 0) items.push({ formFeed: true })
        if (part !== '' || (index === 0 && parts.length === 1)) items.push({ text: part, newline: hasNewline || index < parts.length - 1 })
      })
      if (parts[parts.length - 1] === '' && !hasNewline) { /* a final form feed */ }
    } else items.push({ text, newline: hasNewline })
    start = end + 1
  }
  return items
}

/** The header line between the date and the page number */
function headerLine(date, name, page, width) {
  const pageText = `Page ${page}`
  const rest = width - date.length - pageText.length - name.length
  const left = rest < 2 ? 1 : Math.floor(rest / 2)
  const right = rest < 2 ? 1 : rest - left
  return date + spaces(left) + name + spaces(right) + pageText
}

export function runPr(args, host, getopt) {
  let out = ''
  let err = ''
  let status = 0
  const parsed = parseArgs(args, getopt)
  if (parsed.help) return { out: PR_USAGE + '\n', err, status: 0 }
  if (parsed.version) return { out: 'pr (GNU coreutils) 9.11\n', err, status: 0 }
  if (parsed.error) {
    err = `pr: ${parsed.error}\n` + (parsed.usage ? "Try 'pr --help' for more information.\n" : '')
    return { out, err, status: 1 }
  }
  const o = parsed.options
  // text from the command line goes out as its UTF-8 bytes, like the file content
  const binary = text => (text === undefined || text === true ? text : unescape(encodeURIComponent(text)))
  o.header = binary(o.header)
  o.sepString = binary(o.sepString)
  o.dateFormat = binary(o.dateFormat)
  const names = o.files.length ? o.files : ['-']
  if (o.merge && o.columnsGiven) return { out, err: 'pr: cannot specify number of columns when printing in parallel\n', status: 1 }
  if (o.merge && o.across) return { out, err: 'pr: cannot specify both printing across and printing in parallel\n', status: 1 }

  // the page geometry
  const extremities = !o.omitHeader && o.length > 10
  const pageRows = extremities ? o.length - 10 : o.length
  const bodyLines = o.double ? Math.floor(pageRows / 2) : pageRows
  const rowsPerPage = bodyLines

  const read = name => {
    try {
      return name === '-' ? { content: host.readStdin(), mtime: host.now(), name: '' } : { ...host.readFile(name), name }
    } catch (e) {
      if (!o.ignoreOpen) err += `pr: ${quotef(name)}: ${e.reason ?? e.message}\n`
      status = 1
      return undefined
    }
  }

  // separators and column geometry
  const columnsOf = count => (o.merge ? count : o.columns)
  const make = count => {
    const columns = columnsOf(count)
    const sepKind = o.sepKind
    const sepString = sepKind === 'S' ? o.sepString : sepKind === 's' ? (o.sepString ?? (o.widthKind ? '' : '\t')) : o.join ? '\t' : ' '
    const sepOnly = sepKind === 's' && !o.widthKind
    const aligned = !o.join && sepKind !== 's'
    const number = o.number
    const numberWidth = number ? number.digits + (number.char === '\t' ? 8 - (number.digits % 8) : 1) : 0
    const sepWidth = sepKind === 's' ? Math.min(1, sepString.length) : sepString.length
    const slot = Math.floor((o.width - (o.merge ? numberWidth : 0) - (columns - 1) * sepWidth) / columns)
    const truncates = columns > 1 ? !o.join && !(sepKind === 's' && !o.widthKind) : o.widthKind === 'W' && !o.join
    return { columns, sepString, sepWidth, sepOnly, aligned, number, numberWidth, slot, truncates }
  }

  const formatNumber = (n, g) => {
    const digits = g.number.digits
    let text = String(n)
    if (text.length > digits) text = text.slice(text.length - digits)
    return text.padStart(digits, ' ')
  }

  const cellOf = (item, g, index) => {
    // one cell: the text cut to the room there is after the number
    const limit = g.truncates ? Math.max(1, (g.columns > 1 ? g.slot : o.width) - (o.merge ? 0 : g.numberWidth)) : undefined
    const prepared = prepare(item.text, o, limit, g.columns > 1)
    return { number: g.number ? formatNumber(index, g) : undefined, text: prepared.text, width: prepared.width, unterminated: !item.newline }
  }

  const tabOut = o.output ?? { char: '\t', width: 8 }

  const emitRows = (rows, g) => {
    // rows: arrays of cells (undefined for a column with nothing); returns the lines of the page body
    const multi = g.columns > 1
    const tabsOn = Boolean(o.output) || multi
    const tab = tabsOn ? tabOut : undefined
    const lines = []
    for (const cells of rows) {
      let last = -1
      cells.forEach((cell, k) => { if (cell) last = k })
      let line = ''
      let pos = 0
      if (o.indent) { line += tabsOn ? pad(0, o.indent, tab) : spaces(o.indent); pos = o.indent }
      for (let k = 0; k <= last; k++) {
        const cell = cells[k]
        let nominal = o.indent
        if (k > 0) {
          nominal = o.indent + (o.merge ? g.numberWidth : 0) + k * (g.slot + g.sepWidth)
          if (g.sepOnly || o.join) { line += g.sepString; pos += g.sepWidth }
          else {
            const start = o.indent + (o.merge ? g.numberWidth : 0) + k * (g.slot + g.sepWidth)
            if (g.sepString === ' ') { line += pad(pos, start, tab); pos = Math.max(pos, start) }
            else { line += pad(pos, start - g.sepWidth, tab) + g.sepString; pos = Math.max(pos, start - g.sepWidth) + g.sepWidth }
          }
        }
        if (!cell) continue
        const cellStart = k > 0 && !g.sepOnly && !o.join ? nominal : pos
        if (cell.number !== undefined) {
          const lead = cell.number.length - cell.number.trimStart().length
          const leadEnd = Math.max(pos, cellStart + lead)
          line += (tabsOn ? pad(pos, leadEnd, tab) : spaces(leadEnd - pos)) + cell.number.trimStart()
          pos = leadEnd + cell.number.trimStart().length
          if (g.number.char !== '\t') { line += g.number.char; pos += 1 }
          else if (!multi) { line += '\t'; pos = cellStart + g.numberWidth }
          else if (cell.text !== '') { line += pad(pos, cellStart + g.numberWidth, tab); pos = cellStart + g.numberWidth }
        }
        if (tabsOn) {
          // spaces at the end of a cell are only printed when something follows them
          const core = cell.text.replace(/ +$/, '')
          line += tabify(core, tabOut, pos)
          pos += cell.width - (cell.text.length - core.length)
        } else {
          line += cell.text
          pos += cell.width
        }
        if (cell.stray !== undefined) {
          const lead = cell.stray.length - cell.stray.trimStart().length
          line += pad(pos, pos + lead, tab) + cell.stray.trimStart()
          pos += g.number.digits
        }
      }
      if (tabsOn && !multi && !o.sepKind && o.indent && cells.every(cell => !cell || (cell.text === '' && cell.number === undefined))) line = ''
      lines.push({ text: line, unterminated: cells.some(cell => cell && cell.unterminated) })
    }
    return lines
  }

  const dateOf = mtime => {
    const format = o.dateFormat ?? '%Y-%m-%d %H:%M'
    return strftime(format, { ms: mtime, utc: host.utc ?? false, zone: host.zone ?? 'UTC' })
  }

  const printPages = (pageList, files, g) => {
    // pageList: array of pages, each { rows } ; files: first file info for the header
    const first = files[0]
    const date = dateOf(o.merge || first.name === '' ? host.now() : first.mtime)
    const name = o.header !== undefined ? o.header : o.merge ? '' : first.name
    let printed = 0
    pageList.forEach((page, index) => {
      const number = index + 1
      if (number < o.firstPage || number > o.lastPage) return
      let text = ''
      if (extremities) {
        text += (o.indent ? (Boolean(o.output) || g.columns > 1 ? pad(0, o.indent, tabOut) : spaces(o.indent)) : '') + '\n\n'
        text += spaces(o.indent) + headerLine(date, name, number, o.width) + '\n\n\n'
      }
      const body = page.rows
      let used = 0
      for (const row of body) {
        text += row.text + '\n'
        used++
        if (o.double && !row.unterminated) { text += '\n'; used++ }
      }
      if (extremities) {
        if (o.formFeed) text += (o.double && used < pageRows ? '\n' : '') + '\f'
        else {
          text += '\n'.repeat(Math.max(0, pageRows - used)) + '\n\n\n\n\n'
        }
      }
      out += text
      printed++
    })
  }

  const layoutDown = (entries, g) => {
    // entries: cell objects for one page, in input order; returns rows
    const count = entries.length
    const base = Math.floor(count / g.columns)
    const extra = count % g.columns
    const sizes = []
    for (let k = 0; k < g.columns; k++) sizes.push(base + (k < extra ? 1 : 0))
    const rows = []
    const rowCount = sizes[0]
    const offsets = []
    let at = 0
    for (let k = 0; k < g.columns; k++) { offsets.push(at); at += sizes[k] }
    for (let r = 0; r < rowCount; r++) {
      const cells = []
      for (let k = 0; k < g.columns; k++) cells.push(r < sizes[k] ? entries[offsets[k] + r] : undefined)
      rows.push(cells)
    }
    return rows
  }

  const layoutAcross = (entries, g) => {
    const rows = []
    for (let i = 0; i < entries.length; i += g.columns) {
      const cells = []
      for (let k = 0; k < g.columns; k++) cells.push(entries[i + k])
      rows.push(cells)
    }
    return rows
  }

  if (o.merge) {
    const loaded = names.map(read)
    const files = loaded.filter(Boolean)
    if (files.length === 0) return { out, err, status }
    const g = make(files.length)
    if (g.slot < 1) return { out, err: err + 'pr: page width too narrow\n', status: 1 }
    const itemLists = files.map(f => lineItems(f.content, o).filter(item => !item.formFeed))
    const rowCount = Math.max(0, ...itemLists.map(list => list.length))
    const pageList = []
    let current = []
    for (let r = 0; r < rowCount; r++) {
      const cells = itemLists.map((list, k) => (r < list.length ? list[r] : undefined))
      current.push({ r, cells })
      if (current.length === bodyLines) { pageList.push(current); current = [] }
    }
    if (current.length) pageList.push(current)
    const mergedCount = pageList.length + (pageList.length && pageList[pageList.length - 1].length === bodyLines && itemLists.every(list => list.length === 0 || list[list.length - 1].newline) ? 1 : 0)
    if (mergedCount < o.firstPage) return { out, err: err + `pr: starting page number ${o.firstPage} exceeds page count ${mergedCount}\n`, status }
    const firstShown = Math.max(0, (o.firstPage - 1) * bodyLines)
    let shift = 0
    const pages = pageList.map(rows => ({
      rows: emitRows(rows.map(({ r, cells }) => {
        const n = (o.firstNumber === undefined ? r + 1 : o.firstNumber + r - firstShown) + shift
        const row = cells.map((item, k) => cellOf(item ?? { text: '', newline: true }, k === 0 ? g : { ...g, number: undefined, numberWidth: 0 }, n))
        if (g.number && cells[0] && !cells[0].newline) {
          // the unterminated last line of the first file is followed by the number of the next row
          row[0].stray = formatNumber(n + 1, g)
          shift++
        }
        return row
      }), g)
    }))
    printPages(pages, files, g)
    return { out, err, status }
  }

  for (const name of names) {
    const file = read(name)
    if (!file) continue
    const g = make(1)
    if (g.slot < 1) return { out, err: err + 'pr: page width too narrow\n', status: 1 }
    const items = lineItems(file.content, o)
    if (items.length === 0) {
      if (o.firstPage > 1) err += `pr: starting page number ${o.firstPage} exceeds page count 1\n`
      continue
    }
    // split the items into pages
    const capacity = g.columns * bodyLines
    const pageItems = []
    let current = []
    let pending = false
    for (const item of items) {
      if (item.formFeed) {
        if (current.length || pending) { pageItems.push(current); current = [] }
        pending = false
        continue
      }
      current.push(item)
      pending = true
      if (current.length === capacity) { pageItems.push(current); current = []; pending = false }
    }
    if (current.length) pageItems.push(current)
    const lastPage = pageItems[pageItems.length - 1]
    const pageCount = pageItems.length + (lastPage.length === capacity && lastPage[lastPage.length - 1].newline ? 1 : 0)
    if (pageCount < o.firstPage) { err += `pr: starting page number ${o.firstPage} exceeds page count ${pageCount}\n`; continue }
    let index = 0
    const firstShownIndex = pageItems.slice(0, o.firstPage - 1).reduce((sum, p) => sum + p.length, 0)
    const pages = pageItems.map(list => {
      const entries = list.map(item => {
        const n = o.firstNumber === undefined ? index + 1 : o.firstNumber + index - firstShownIndex
        index++
        return cellOf(item, g, n)
      })
      const rows = g.columns === 1 ? entries.map(e => [e]) : o.across ? layoutAcross(entries, g) : layoutDown(entries, g)
      return { rows: emitRows(rows, g) }
    })
    printPages(pages, [file], g)
  }
  return { out, err, status }
}
