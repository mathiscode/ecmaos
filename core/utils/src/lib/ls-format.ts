/**
 * The pure parts of `ls`: option parsing, sorting, and the text of each output format. The program
 * (`commands-execve/ls.mjs`) does the filesystem and terminal work; everything here is a function of
 * its arguments, so it is tested without a kernel.
 */

export type LsFormat = 'columns' | 'across' | 'commas' | 'long' | 'single'
export type LsSort = 'name' | 'time' | 'size' | 'none' | 'extension' | 'version'
export type LsQuoting = 'literal' | 'escape' | 'c' | 'shell' | 'shell-always' | 'shell-escape' | 'shell-escape-always' | 'locale' | 'clocale'

export interface LsOptions {
  all: boolean
  almostAll: boolean
  directory: boolean
  human: boolean
  recursive: boolean
  reverse: boolean
  classify: boolean
  /** `--file-type`: the `-F` indicators except `*` */
  fileType: boolean
  slash: boolean
  inode: boolean
  /** `-s`: the allocated size in blocks before each name */
  blocks: boolean
  long: boolean
  /** The layout chosen by the last of `-C -x -m -l -1 --format`; `undefined` leaves it to whether output is a terminal. */
  format: LsFormat | undefined
  numericIds: boolean
  /** `-g`, `-o`, `-G`: leave the owner or group column out of the long format. */
  hideOwner: boolean
  hideGroup: boolean
  oneColumn: boolean
  sort: LsSort
  /** Which time `-t` sorts by and `-l` shows: modification, access (`-u`) or status change (`-c`). */
  time: 'mtime' | 'atime' | 'ctime'
  dirsFirst: boolean
  quoting: LsQuoting
  /** Whether `-b`, `-Q`, `-N` or `--quoting-style` was given; without one, a terminal gets `shell-escape`. */
  quotingGiven: boolean
  hideControl: boolean
  /** `-I`/`--hide` shell patterns */
  ignore: string[]
  /** `-L`, `-H`: follow every link, or only those named on the command line. */
  dereference: 'none' | 'cmdline' | 'all'
  timeStyle: string | undefined
  /** `-w`: the line width for the column layouts; `undefined` is the terminal's (or 80). */
  width: number | undefined
  tabsize: number
  /** `--color`: never colors; auto colors on a terminal; always colors regardless. */
  color: 'never' | 'auto' | 'always'
  operands: string[]
  help: boolean
}

export interface LsParseResult { options: LsOptions, error?: string }

const SORT_WORDS: Record<string, LsSort> = { none: 'none', size: 'size', time: 'time', version: 'version', extension: 'extension', name: 'name', width: 'name' }
const FORMAT_WORDS: Record<string, LsFormat> = { long: 'long', verbose: 'long', commas: 'commas', across: 'across', horizontal: 'across', vertical: 'columns', 'single-column': 'single' }
const TIME_WORDS: Record<string, 'mtime' | 'atime' | 'ctime'> = { atime: 'atime', access: 'atime', use: 'atime', ctime: 'ctime', status: 'ctime', mtime: 'mtime', modification: 'mtime' }
const COLOR_WORDS: Record<string, LsOptions['color']> = { always: 'always', yes: 'always', force: 'always', never: 'never', no: 'never', none: 'never', auto: 'auto', tty: 'auto', 'if-tty': 'auto' }

/** Long option -> [letter or special key, argument: none | required | optional] */
const LONG_OPTIONS: Record<string, [string, 'none' | 'required' | 'optional']> = {
  all: ['a', 'none'], 'almost-all': ['A', 'none'], directory: ['d', 'none'], 'human-readable': ['h', 'none'], recursive: ['R', 'none'],
  reverse: ['r', 'none'], classify: ['F', 'none'], 'file-type': ['file-type', 'none'], inode: ['i', 'none'], size: ['s', 'none'],
  'dereference-command-line': ['H', 'none'], dereference: ['L', 'none'], 'numeric-uid-gid': ['n', 'none'], 'no-group': ['G', 'none'],
  'hide-control-chars': ['q', 'none'], 'show-control-chars': ['show-control', 'none'], escape: ['b', 'none'], 'quote-name': ['Q', 'none'],
  literal: ['N', 'none'], 'group-directories-first': ['group-directories-first', 'none'], 'full-time': ['full-time', 'none'],
  color: ['color', 'optional'], colour: ['color', 'optional'], hide: ['hide', 'required'], ignore: ['I', 'required'],
  sort: ['sort', 'required'], format: ['format', 'required'], time: ['time', 'required'], 'time-style': ['time-style', 'required'],
  width: ['w', 'required'], tabsize: ['T', 'required'], 'indicator-style': ['indicator-style', 'required'], 'quoting-style': ['quoting-style', 'required'],
  'ignore-backups': ['B', 'none'], 'block-size': ['block-size', 'required'], 'kibibytes': ['k', 'none'], help: ['?', 'none'], version: ['?', 'none'],
  context: ['Z', 'none'], author: ['author', 'none'], 'si': ['si', 'none'], dired: ['dired', 'none'], zero: ['zero', 'none']
}

const SHORT_WITH_ARG = 'IwT'

/** Parses `ls` arguments: short flags may be clustered (`-la`), `--` ends options, `--help` asks for usage; GNU's error wording. */
export function parseLsArguments(args: string[]): LsParseResult {
  const options: LsOptions = {
    all: false, almostAll: false, directory: false, human: false, recursive: false, reverse: false, classify: false, fileType: false,
    slash: false, inode: false, blocks: false, long: false, format: undefined, numericIds: false, hideOwner: false, hideGroup: false,
    oneColumn: false, sort: 'name', time: 'mtime', dirsFirst: false, quoting: 'literal', quotingGiven: false, hideControl: false, ignore: [], dereference: 'none',
    timeStyle: undefined, width: undefined, tabsize: 8, color: 'never', operands: [], help: false
  }
  const fail = (error: string): LsParseResult => ({ options, error })
  const layout = (format: LsFormat) => {
    options.format = format
    options.long = format === 'long'
    options.oneColumn = format === 'single'
  }
  let error: string | undefined
  let sortFlag = false

  const apply = (key: string, value?: string): void => {
    switch (key) {
      case 'a': options.all = true; options.almostAll = false; break
      case 'A': options.almostAll = true; if (!options.all) options.almostAll = true; break
      case 'f': options.all = true; options.sort = 'none'; options.color = 'never'; break
      case 'd': options.directory = true; break
      case 'h': options.human = true; break
      case 'R': options.recursive = true; break
      case 'r': options.reverse = true; break
      case 'F': options.classify = true; options.fileType = false; break
      case 'file-type': options.fileType = true; break
      case 'p': options.slash = true; break
      case 'i': options.inode = true; break
      case 's': options.blocks = true; break
      case 'k': case 'si': case 'dired': case 'author': case 'Z': case 'B': case 'G-ignored': break
      case 'l': layout('long'); break
      case '1': layout('single'); break
      case 'C': layout('columns'); break
      case 'x': layout('across'); break
      case 'm': layout('commas'); break
      case 'n': options.numericIds = true; layout('long'); break
      case 'g': options.hideOwner = true; layout('long'); break
      case 'o': options.hideGroup = true; layout('long'); break
      case 'G': options.hideGroup = true; break
      case 't': options.sort = 'time'; sortFlag = true; break
      case 'S': options.sort = 'size'; break
      case 'U': options.sort = 'none'; break
      case 'v': options.sort = 'version'; break
      case 'X': options.sort = 'extension'; break
      case 'u': options.time = 'atime'; break
      case 'c': options.time = 'ctime'; break
      case 'H': options.dereference = 'cmdline'; break
      case 'L': options.dereference = 'all'; break
      case 'q': options.hideControl = true; break
      case 'show-control': options.hideControl = false; break
      case 'b': options.quoting = 'escape'; options.quotingGiven = true; break
      case 'Q': options.quoting = 'c'; options.quotingGiven = true; break
      case 'N': options.quoting = 'literal'; options.quotingGiven = true; break
      case 'group-directories-first': options.dirsFirst = true; break
      case 'full-time': layout('long'); options.timeStyle = 'full-iso'; break
      case 'I': case 'hide': options.ignore.push(value!); break
      case '?': options.help = true; break
      case 'w': {
        if (!/^\d+$/.test(value!)) { error = `invalid line width: '${value}'`; break }
        options.width = Number(value)
        break
      }
      case 'T': {
        if (!/^\d+$/.test(value!)) { error = `invalid tab size: '${value}'`; break }
        options.tabsize = Number(value)
        break
      }
      case 'color': {
        const when = value ?? 'always'
        const mapped = COLOR_WORDS[when]
        if (!mapped) { error = `invalid argument '${when}' for '--color'\nValid arguments are:\n  - 'always', 'yes', 'force'\n  - 'never', 'no', 'none'\n  - 'auto', 'tty', 'if-tty'`; break }
        options.color = mapped
        break
      }
      case 'sort': case 'format': case 'time': case 'indicator-style': case 'quoting-style': case 'block-size': {
        const table = key === 'sort' ? SORT_WORDS : key === 'format' ? FORMAT_WORDS : key === 'time' ? TIME_WORDS : null
        if (key === 'indicator-style') {
          const words: Record<string, () => void> = { none: () => { options.classify = options.fileType = options.slash = false }, slash: () => { options.slash = true }, 'file-type': () => { options.fileType = true }, classify: () => { options.classify = true } }
          if (!words[value!]) { error = `invalid argument '${value}' for '--indicator-style'\nValid arguments are:\n  - 'none'\n  - 'slash'\n  - 'file-type'\n  - 'classify'`; break }
          words[value!]!()
        } else if (key === 'quoting-style') {
          const words: Record<string, LsQuoting> = { literal: 'literal', escape: 'escape', c: 'c', shell: 'shell', 'shell-always': 'shell-always', 'shell-escape': 'shell-escape', 'shell-escape-always': 'shell-escape-always', locale: 'locale', clocale: 'clocale' }
          if (!Object.hasOwn(words, value!)) { error = `invalid argument '${value}' for '--quoting-style'\nValid arguments are:\n${Object.keys(words).map(n => `  - '${n}'`).join('\n')}`; break }
          options.quoting = words[value!]!
          options.quotingGiven = true
        } else if (key === 'block-size') {
          break
        } else if (!table![value!]) {
          const names = key === 'sort' ? ['none', 'size', 'time', 'version', 'extension', 'name', 'width'] : key === 'format' ? ['verbose', 'long', 'commas', 'horizontal', 'across', 'vertical', 'single-column'] : ['atime', 'access', 'use', 'ctime', 'status', 'mtime', 'modification']
          error = `invalid argument '${value}' for '--${key}'\nValid arguments are:\n${names.map(n => `  - '${n}'`).join('\n')}`
        } else if (key === 'sort') options.sort = table![value!] as LsSort
        else if (key === 'format') layout(table![value!] as LsFormat)
        else options.time = table![value!] as 'mtime' | 'atime' | 'ctime'
        break
      }
      case 'time-style': options.timeStyle = value; break
      default: error = `invalid option -- '${key}'`
    }
  }

  let optionsEnded = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (optionsEnded || arg === '-' || !arg.startsWith('-')) { options.operands.push(arg); continue }
    if (arg === '--') { optionsEnded = true; continue }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const given = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      let name = given in LONG_OPTIONS ? given : undefined
      if (name === undefined) {
        const matches = Object.keys(LONG_OPTIONS).filter(candidate => candidate.startsWith(given))
        const keys = new Set(matches.map(m => LONG_OPTIONS[m]![0]))
        if (matches.length === 0) return fail(`unrecognized option '--${given}'`)
        if (keys.size > 1) return fail(`option '--${given}' is ambiguous; possibilities:${matches.map(m => ` '--${m}'`).join('')}`)
        name = matches[0]
      }
      const [key, kind] = LONG_OPTIONS[name!]!
      let value: string | undefined
      if (kind === 'none') { if (eq !== -1) return fail(`option '--${name}' doesn't allow an argument`) }
      else if (eq !== -1) value = arg.slice(eq + 1)
      else if (kind === 'required') {
        if (i + 1 >= args.length) return fail(`option '--${name}' requires an argument`)
        value = args[++i]
      }
      apply(key, value)
      if (error) return fail(error)
      continue
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]!
      if (SHORT_WITH_ARG.includes(flag)) {
        let value = arg.slice(j + 1)
        if (value === '') {
          if (i + 1 >= args.length) return fail(`option requires an argument -- '${flag}'`)
          value = args[++i]!
        }
        apply(flag, value)
        if (error) return fail(error)
        break
      }
      apply(flag)
      if (error) return fail(error)
    }
  }
  void sortFlag
  return { options }
}

export interface LsEntry {
  name: string
  /** The file has an extended ACL, shown as a `+` after the mode */
  acl?: boolean
  mode: number
  size: number
  mtimeMs: number
  atimeMs?: number
  ctimeMs?: number
  uid: number
  gid: number
  nlink: number
  ino: number
  rdev: number
  blocks: number
  linkTarget?: string
}

const S_IFMT = 0o170000
const TYPES: Record<number, string> = { 0o040000: 'd', 0o020000: 'c', 0o060000: 'b', 0o010000: 'p', 0o120000: 'l', 0o140000: 's' }

export function isDirectoryMode(mode: number): boolean { return (mode & S_IFMT) === 0o040000 }
export function isLinkMode(mode: number): boolean { return (mode & S_IFMT) === 0o120000 }
const isDeviceMode = (mode: number) => (mode & S_IFMT) === 0o020000 || (mode & S_IFMT) === 0o060000

/** `drwxr-xr-t`: file type, then the nine permission characters with setuid, setgid and sticky folded in. */
export function modeString(mode: number): string {
  // a link's own permission bits are never consulted, and Linux always reports them as 0777
  if ((mode & S_IFMT) === 0o120000) mode |= 0o777
  const triplet = (read: number, write: number, exec: number, special: number, letter: string) => {
    const third = mode & special ? (mode & exec ? letter : letter.toUpperCase()) : (mode & exec ? 'x' : '-')
    return (mode & read ? 'r' : '-') + (mode & write ? 'w' : '-') + third
  }
  return (TYPES[mode & S_IFMT] ?? '-') + triplet(0o400, 0o200, 0o100, 0o4000, 's') + triplet(0o040, 0o020, 0o010, 0o2000, 's') + triplet(0o004, 0o002, 0o001, 0o1000, 't')
}

/** GNU's `-h`: powers of 1024, rounded up, one decimal below 10 (`1.0K`, `4.0K`, `12K`). */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes)
  const units = ['K', 'M', 'G', 'T', 'P']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  if (value < 10) {
    const rounded = Math.ceil(value * 10) / 10
    // 9.95 rounds up to 10.0, which GNU shows as 10
    return rounded >= 10 ? `${Math.ceil(rounded)}${units[unit]}` : `${rounded.toFixed(1)}${units[unit]}`
  }
  return `${Math.ceil(value)}${units[unit]}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SIX_MONTHS_MS = 182.5 * 24 * 3600 * 1000

/** `Oct  3 15:00` for a recent file, `Oct  3  2024` for one older than six months or in the future. */
export function longDate(mtimeMs: number, now: number): string {
  const date = new Date(mtimeMs)
  const day = String(date.getDate()).padStart(2, ' ')
  const recent = mtimeMs <= now && now - mtimeMs < SIX_MONTHS_MS
  const tail = recent
    ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : ` ${date.getFullYear()}`
  return `${MONTHS[date.getMonth()]} ${day} ${tail}`
}

/** `-F`/`-p`/`--file-type` suffix: `/` directory, `*` executable (not for `--file-type`), `@` link, `|` fifo, `=` socket. */
export function indicator(entry: Pick<LsEntry, 'mode'>, options: Pick<LsOptions, 'classify' | 'slash'> & { fileType?: boolean }): string {
  const type = entry.mode & S_IFMT
  if (type === 0o040000 && (options.classify || options.slash || options.fileType)) return '/'
  if (!options.classify && !options.fileType) return ''
  if (type === 0o120000) return '@'
  if (type === 0o010000) return '|'
  if (type === 0o140000) return '='
  if (options.classify && type === 0o100000 && entry.mode & 0o111) return '*'
  return ''
}

/** The time `-t` sorts by and `-l` shows */
export function entryTime(entry: LsEntry, which: 'mtime' | 'atime' | 'ctime' = 'mtime'): number {
  if (which === 'atime') return entry.atimeMs ?? entry.mtimeMs
  if (which === 'ctime') return entry.ctimeMs ?? entry.mtimeMs
  return entry.mtimeMs
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Version order (`ls -v`): runs of digits compare as numbers, everything else bytewise */
export function compareVersion(a: string, b: string): number {
  const parts = (text: string) => text.match(/\d+|\D+/g) ?? []
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!
    const y = right[i]!
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
      if (x.length !== y.length) return x.length < y.length ? 1 : -1
    } else if (x !== y) return compareText(x, y)
  }
  return left.length - right.length
}

const extensionOf = (name: string) => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1) : '' }

export interface SortOptions { sort: LsSort, reverse: boolean, time?: 'mtime' | 'atime' | 'ctime', dirsFirst?: boolean }

/**
 * Orders entries as `ls` does in the C.UTF-8 locale: names bytewise (so it agrees with `sort`), or by time (newest first),
 * size (largest first), extension or version, ties by name; reversed if asked; directories first on request.
 */
export function sortEntries<T extends Pick<LsEntry, 'name' | 'mtimeMs' | 'size'> & Partial<LsEntry>>(entries: T[], options: SortOptions): T[] {
  const dirKey = (e: T) => (options.dirsFirst && e.mode !== undefined && isDirectoryMode(e.mode) ? 0 : 1)
  if (options.sort === 'none') {
    const list = options.reverse ? [...entries].reverse() : [...entries]
    return options.dirsFirst ? list.sort((a, b) => dirKey(a) - dirKey(b)) : list
  }
  const time = (e: T) => entryTime(e as unknown as LsEntry, options.time)
  const byName = (a: T, b: T) => compareText(a.name, b.name)
  const compare = options.sort === 'time' ? (a: T, b: T) => time(b) - time(a) || byName(a, b)
    : options.sort === 'size' ? (a: T, b: T) => b.size - a.size || byName(a, b)
      : options.sort === 'extension' ? (a: T, b: T) => compareText(extensionOf(a.name), extensionOf(b.name)) || byName(a, b)
        : options.sort === 'version' ? (a: T, b: T) => compareVersion(a.name, b.name) || byName(a, b)
          : byName
  return [...entries].sort((a, b) => dirKey(a) - dirKey(b) || (options.reverse ? compare(b, a) : compare(a, b)))
}

export interface Names { users: Map<number, string>, groups: Map<number, string> }

/** `/etc/passwd` or `/etc/group` text to id -> name. */
export function parseNames(text: string): Map<number, string> {
  const names = new Map<number, string>()
  for (const line of text.split('\n')) {
    const [name, , id] = line.split(':')
    if (name && id !== undefined && /^\d+$/.test(id) && !names.has(Number(id))) names.set(Number(id), name)
  }
  return names
}

const ESCAPES: Record<string, string> = { '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' }

/** What `ls` quotes in `shell` styles: anything the shell would read as syntax, and `#` and `~` at the start. */
const SHELL_SPECIAL = /[\s|&;<>()$`"'\\*?[\]^!=]/

/** A name as the quoting options show it: `-q` makes control characters `?`, `-b` escapes them (and spaces), `-Q` quotes it in C style, the `shell` and `locale` styles as GNU's. */
export function quoteName(name: string, quoting: LsQuoting = 'literal', hideControl = false): string {
  const control = (ch: string) => ch < ' ' || ch === '\x7f'
  if (quoting === 'literal') return hideControl ? [...name].map(ch => (control(ch) ? '?' : ch)).join('') : name
  if (quoting.startsWith('shell')) return shellQuote(name, quoting, control)
  let out = ''
  const locale = quoting === 'locale' || quoting === 'clocale'
  for (const ch of name) {
    if (ch in ESCAPES) out += ESCAPES[ch]
    else if (ch === '\\') out += '\\\\'
    else if (quoting === 'c' && ch === '"') out += '\\"'
    else if (locale && ch === '\'') out += "'"
    else if (quoting === 'escape' && ch === ' ') out += '\\ '
    else if (control(ch)) out += '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0')
    else out += ch
  }
  if (locale) return `\u2018${out}\u2019`
  return quoting === 'c' ? `"${out}"` : out
}

/** `shell`, `shell-always`, `shell-escape` and `shell-escape-always`: quote a name so the shell reads it back as the same word. */
function shellQuote(name: string, quoting: LsQuoting, control: (ch: string) => boolean): string {
  const always = quoting.endsWith('-always')
  const escape = quoting.startsWith('shell-escape')
  const hasControl = [...name].some(control)
  const special = SHELL_SPECIAL.test(name) || /^[#~]/.test(name) || (hasControl && !escape)
  if (name === '') return "''"
  if (!special && !hasControl && !always) return name
  if (hasControl && escape) {
    // printable runs in single quotes, the rest as $'\ooo' pieces: 'a'$'\t''b'
    let out = ''
    let run = ''
    const flush = () => { if (run) { out += `'${run.replace(/'/g, "'\\''")}'`; run = '' } }
    for (const ch of name) {
      if (control(ch)) {
        flush()
        out += `$'${ch in ESCAPES ? ESCAPES[ch] : '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0')}'`
      } else run += ch
    }
    flush()
    return out
  }
  // a single quote and nothing that double quotes would still expand: "a'b"
  if (name.includes("'") && !/["$`\\]/.test(name)) return `"${name}"`
  return `'${name.replace(/'/g, "'\\''")}'`
}

/** Whether a quoted name starts with a quote, so that unquoted names in the same listing are indented to line up with it. */
export const startsQuoted = (shown: string) => shown.startsWith("'") || shown.startsWith('"')

/** The styles whose quoting leaves a name unquoted when it needs none, and so line up with the quoted ones. */
export const alignsQuotes = (quoting: LsQuoting) => quoting === 'shell' || quoting === 'shell-escape'

const DEVICE_MINOR_BITS = 20

/** `paint` colors a file's name for `--color`; widths are measured before it is applied. */
export interface LongFormatOptions {
  human: boolean
  inode: boolean
  classify: boolean
  slash: boolean
  fileType?: boolean
  blocks?: boolean
  numericIds?: boolean
  hideOwner?: boolean
  hideGroup?: boolean
  quoting?: LsQuoting
  hideControl?: boolean
  time?: 'mtime' | 'atime' | 'ctime'
  /** The date column for one entry; the default is `ls`'s usual `Oct  3 15:00` / `Oct  3  2024`. */
  date?: (entry: LsEntry) => string
  paint?: (entry: LsEntry, name: string) => string
}

/** Allocated size in 1K blocks */
/** Space a file takes, in 1K units: whole 4 KiB blocks, and none for a directory, a symlink or a device (as `du` counts) */
export const blocksOf = (entry: LsEntry) => isDirectoryMode(entry.mode) || isLinkMode(entry.mode) || isDeviceMode(entry.mode) ? 0 : 4 * Math.ceil(entry.size / 4096)

/** Lines of `ls -l` for one directory's entries, columns aligned; `total` is in 1K blocks. */
export function longLines(entries: LsEntry[], names: Names, options: LongFormatOptions, now: number, withTotal: boolean): string[] {
  const pad = alignsQuotes(options.quoting ?? 'literal') && entries.some(entry => startsQuoted(quoteName(entry.name, options.quoting, options.hideControl)))
  const rows = entries.map(entry => {
    const size = isDeviceMode(entry.mode)
      ? `${entry.rdev >>> DEVICE_MINOR_BITS}, ${entry.rdev & ((1 << DEVICE_MINOR_BITS) - 1)}`
      : options.human ? humanSize(entry.size) : String(entry.size)
    const shown = quoteName(entry.name, options.quoting, options.hideControl)
    const name = (pad && !startsQuoted(shown) ? ' ' : '') + (options.paint ? options.paint(entry, shown) : shown) + indicator(entry, options) + (entry.linkTarget !== undefined ? ` -> ${quoteName(entry.linkTarget, options.quoting, options.hideControl)}` : '')
    return {
      inode: String(entry.ino),
      blocks: options.human ? humanSize(blocksOf(entry) * 1024) : String(blocksOf(entry)),
      mode: modeString(entry.mode) + (entry.acl ? '+' : ' ').trimEnd(),
      nlink: String(entry.nlink),
      owner: options.numericIds ? String(entry.uid) : names.users.get(entry.uid) ?? String(entry.uid),
      group: options.numericIds ? String(entry.gid) : names.groups.get(entry.gid) ?? String(entry.gid),
      size,
      date: options.date ? options.date(entry) : longDate(entryTime(entry, options.time), now),
      name
    }
  })
  const width = (pick: (row: (typeof rows)[number]) => string) => Math.max(0, ...rows.map(row => pick(row).length))
  const w = { inode: width(r => r.inode), blocks: width(r => r.blocks), nlink: width(r => r.nlink), owner: width(r => r.owner), group: width(r => r.group), size: width(r => r.size) }
  const lines = rows.map(row =>
    (options.inode ? `${row.inode.padStart(w.inode)} ` : '') +
    (options.blocks ? `${row.blocks.padStart(w.blocks)} ` : '') +
    `${row.mode} ${row.nlink.padStart(w.nlink)} ` +
    (options.hideOwner ? '' : `${row.owner.padEnd(w.owner)} `) +
    (options.hideGroup ? '' : `${row.group.padEnd(w.group)} `) +
    `${row.size.padStart(w.size)} ${row.date} ${row.name}`
  )
  if (withTotal) {
    const blocks = entries.reduce((sum, entry) => sum + blocksOf(entry), 0)
    lines.unshift(`total ${options.human ? humanSize(blocks * 1024) : blocks}`)
  }
  return lines
}

/** Moves from column `from` to column `to` with tabs where a tab stop allows, then spaces, as GNU does */
function indent(from: number, to: number, tabsize: number): string {
  let out = ''
  while (from < to) {
    if (tabsize !== 0 && Math.floor(to / tabsize) > Math.floor((from + 1) / tabsize)) { out += '\t'; from += tabsize - (from % tabsize) }
    else { out += ' '; from++ }
  }
  return out
}

export interface ColumnOptions { across?: boolean, tabsize?: number }

/**
 * The names laid out the way GNU `ls` does: the largest number of columns whose lines fit in `width`, each column as
 * wide as its longest name plus two, filled down the columns (`-C`) or across the rows (`-x`), separated by tabs where
 * tab stops allow.
 */
export function columnLines(labels: string[], width: number, paint?: (label: string, index: number) => string, options: ColumnOptions = {}): string[] {
  const n = labels.length
  if (!n) return []
  const across = options.across ?? false
  const tabsize = options.tabsize ?? 8
  const lengths = labels.map(label => label.length)
  const maxCols = Math.min(Math.max(Math.floor((width + 2) / 3), 1), n)
  const info = Array.from({ length: maxCols }, (_, i) => ({ valid: true, lineLen: (i + 1) * 3, cols: new Array<number>(i + 1).fill(3) }))
  for (let file = 0; file < n; file++) {
    for (let i = 0; i < maxCols; i++) {
      const column = info[i]!
      if (!column.valid) continue
      const idx = across ? file % (i + 1) : Math.floor(file / Math.ceil(n / (i + 1)))
      const real = lengths[file]! + (idx === i ? 0 : 2)
      if (column.cols[idx]! < real) {
        column.lineLen += real - column.cols[idx]!
        column.cols[idx] = real
        column.valid = column.lineLen < width
      }
    }
  }
  let count = maxCols
  while (count > 1 && !info[count - 1]!.valid) count--
  const show = (index: number) => (paint ? paint(labels[index]!, index) : labels[index]!)
  if (count === 1) return labels.map((_, i) => show(i))
  const cols = info[count - 1]!.cols
  const lines: string[] = []
  if (across) {
    let line = ''
    let pos = 0
    for (let i = 0; i < n; i++) {
      const col = i % count
      if (i !== 0) {
        if (col === 0) { lines.push(line); line = ''; pos = 0 }
        else { line += indent(pos + lengths[i - 1]!, pos + cols[col - 1]!, tabsize); pos += cols[col - 1]! }
      }
      line += show(i)
    }
    lines.push(line)
    return lines
  }
  const rows = Math.ceil(n / count)
  for (let row = 0; row < rows; row++) {
    let line = ''
    let pos = 0
    let file = row
    let col = 0
    for (;;) {
      line += show(file)
      const columnWidth = cols[col++]!
      if (file + rows >= n) break
      line += indent(pos + lengths[file]!, pos + columnWidth, tabsize)
      pos += columnWidth
      file += rows
    }
    lines.push(line)
  }
  return lines
}

/** `-m`: names separated by `, `, wrapped before the line would reach `width` */
export function commaLines(labels: string[], width: number, paint?: (label: string, index: number) => string): string[] {
  const lines: string[] = []
  let line = ''
  let pos = 0
  labels.forEach((label, i) => {
    if (i !== 0) {
      if (width === 0 || pos + label.length + 2 < width) { line += ', '; pos += 2 }
      else { lines.push(line + ','); line = ''; pos = 0 }
    }
    line += paint ? paint(label, i) : label
    pos += label.length
  })
  if (labels.length) lines.push(line)
  return lines
}
