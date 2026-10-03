/**
 * The pure parts of `ls`: option parsing, sorting, and the text of each output format. The program
 * (`commands-execve/ls.mjs`) does the filesystem and terminal work; everything here is a function of
 * its arguments, so it is tested without a kernel.
 */

export interface LsOptions {
  all: boolean
  almostAll: boolean
  directory: boolean
  human: boolean
  recursive: boolean
  reverse: boolean
  classify: boolean
  slash: boolean
  inode: boolean
  long: boolean
  oneColumn: boolean
  sort: 'name' | 'time' | 'size' | 'none'
  operands: string[]
  help: boolean
}

export interface LsParseResult { options: LsOptions, error?: string }

const LONG_FLAGS: Record<string, string> = {
  all: 'a', 'almost-all': 'A', directory: 'd', 'human-readable': 'h', recursive: 'R', reverse: 'r',
  classify: 'F', 'file-type': 'F', inode: 'i', 'dereference-command-line': 'H', color: '', help: '?'
}

/** Parses `ls` arguments: short flags may be clustered (`-la`), `--` ends options, `--help` asks for usage. */
export function parseLsArguments(args: string[]): LsParseResult {
  const options: LsOptions = {
    all: false, almostAll: false, directory: false, human: false, recursive: false, reverse: false, classify: false,
    slash: false, inode: false, long: false, oneColumn: false, sort: 'name', operands: [], help: false
  }
  const apply = (flag: string): string | undefined => {
    switch (flag) {
      case 'a': options.all = true; break
      case 'A': options.almostAll = true; break
      case 'd': options.directory = true; break
      case 'h': options.human = true; break
      case 'R': options.recursive = true; break
      case 'r': options.reverse = true; break
      case 'F': options.classify = true; break
      case 'p': options.slash = true; break
      case 'i': options.inode = true; break
      case 'l': options.long = true; break
      case '1': options.oneColumn = true; options.long = false; break
      case 't': options.sort = 'time'; break
      case 'S': options.sort = 'size'; break
      case 'U': options.sort = 'none'; break
      case 'H': case 'L': case 'C': case 'x': case 'G': case 'k': case 'n': case 'q': case 'b': case '': break
      case '?': options.help = true; break
      default: return flag
    }
    return undefined
  }

  let optionsEnded = false
  for (const arg of args) {
    if (optionsEnded || arg === '-' || !arg.startsWith('-')) { options.operands.push(arg); continue }
    if (arg === '--') { optionsEnded = true; continue }
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0]!
      const flag = LONG_FLAGS[name]
      if (flag === undefined) return { options, error: `unrecognized option '${arg}'` }
      apply(flag)
      continue
    }
    for (const flag of arg.slice(1)) {
      const bad = apply(flag)
      if (bad !== undefined) return { options, error: `invalid option -- '${bad}'` }
    }
  }
  return { options }
}

export interface LsEntry {
  name: string
  mode: number
  size: number
  mtimeMs: number
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

/** GNU's `-h`: powers of 1024, rounded up, one decimal below 10. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes)
  const units = ['K', 'M', 'G', 'T', 'P']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  const rounded = value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value)
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${units[unit]}`
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

/** `-F`/`-p` suffix: `/` directory, `*` executable, `@` link, `|` fifo, `=` socket. */
export function indicator(entry: Pick<LsEntry, 'mode'>, options: Pick<LsOptions, 'classify' | 'slash'>): string {
  const type = entry.mode & S_IFMT
  if (type === 0o040000 && (options.classify || options.slash)) return '/'
  if (!options.classify) return ''
  if (type === 0o120000) return '@'
  if (type === 0o010000) return '|'
  if (type === 0o140000) return '='
  if (type === 0o100000 && entry.mode & 0o111) return '*'
  return ''
}

/** Orders entries as `ls` does: by name (case-insensitively first, as in a UTF-8 locale), time or size, then reversed if asked. */
export function sortEntries<T extends Pick<LsEntry, 'name' | 'mtimeMs' | 'size'>>(entries: T[], options: Pick<LsOptions, 'sort' | 'reverse'>): T[] {
  if (options.sort === 'none') return options.reverse ? [...entries].reverse() : [...entries]
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const compare = options.sort === 'time' ? (a: T, b: T) => b.mtimeMs - a.mtimeMs || byName(a, b)
    : options.sort === 'size' ? (a: T, b: T) => b.size - a.size || byName(a, b)
      : byName
  const sorted = [...entries].sort(compare)
  return options.reverse ? sorted.reverse() : sorted
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

const DEVICE_MINOR_BITS = 20

export interface LongFormatOptions { human: boolean, inode: boolean, classify: boolean, slash: boolean }

/** Lines of `ls -l` for one directory's entries, columns aligned; `total` is in 1K blocks. */
export function longLines(entries: LsEntry[], names: Names, options: LongFormatOptions, now: number, withTotal: boolean): string[] {
  const rows = entries.map(entry => {
    const size = isDeviceMode(entry.mode)
      ? `${entry.rdev >>> DEVICE_MINOR_BITS}, ${entry.rdev & ((1 << DEVICE_MINOR_BITS) - 1)}`
      : options.human ? humanSize(entry.size) : String(entry.size)
    const name = entry.name + indicator(entry, options) + (entry.linkTarget !== undefined ? ` -> ${entry.linkTarget}` : '')
    return {
      inode: String(entry.ino),
      mode: modeString(entry.mode),
      nlink: String(entry.nlink),
      owner: names.users.get(entry.uid) ?? String(entry.uid),
      group: names.groups.get(entry.gid) ?? String(entry.gid),
      size,
      date: longDate(entry.mtimeMs, now),
      name
    }
  })
  const width = (pick: (row: (typeof rows)[number]) => string) => Math.max(0, ...rows.map(row => pick(row).length))
  const w = { inode: width(r => r.inode), nlink: width(r => r.nlink), owner: width(r => r.owner), group: width(r => r.group), size: width(r => r.size) }
  const lines = rows.map(row =>
    (options.inode ? `${row.inode.padStart(w.inode)} ` : '') +
    `${row.mode} ${row.nlink.padStart(w.nlink)} ${row.owner.padEnd(w.owner)} ${row.group.padEnd(w.group)} ${row.size.padStart(w.size)} ${row.date} ${row.name}`
  )
  if (withTotal) {
    const blocks = entries.reduce((sum, entry) => sum + Math.ceil((entry.blocks || Math.ceil(entry.size / 512)) / 2), 0)
    lines.unshift(`total ${options.human ? humanSize(blocks * 1024) : blocks}`)
  }
  return lines
}

/** The names laid out like `ls` on a terminal: filled down the columns, as many as fit in `width`. */
export function columnLines(labels: string[], width: number): string[] {
  if (!labels.length) return []
  const gap = 2
  const longest = Math.max(...labels.map(label => label.length))
  if (longest + gap > width && labels.length > 1) return labels
  let columns = Math.max(1, Math.min(labels.length, Math.floor((width + gap) / (longest + gap))))
  // The widest layout whose lines all fit, each column as wide as its own longest name
  for (; columns > 1; columns--) {
    const rows = Math.ceil(labels.length / columns)
    const widths: number[] = []
    for (let c = 0; c < columns; c++) widths.push(Math.max(0, ...labels.slice(c * rows, (c + 1) * rows).map(label => label.length)))
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * (columns - 1)
    if (total <= width) break
  }
  const rows = Math.ceil(labels.length / columns)
  const widths: number[] = []
  for (let c = 0; c < columns; c++) widths.push(Math.max(0, ...labels.slice(c * rows, (c + 1) * rows).map(label => label.length)))
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < columns; c++) {
      const label = labels[c * rows + r]
      if (label === undefined) continue
      line += c === columns - 1 || labels[(c + 1) * rows + r] === undefined ? label : label.padEnd(widths[c]! + gap)
    }
    lines.push(line)
  }
  return lines
}
