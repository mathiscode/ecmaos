/**
 * List directory contents, as GNU `ls` does: names (in columns on a terminal, one per line otherwise),
 * `-l` for the long format with owner and group names read from /etc/passwd and /etc/group, and the
 * usual -a -A -d -h -R -r -t -S -U -F -p -i -1 flags. The formatting lives in `lib/ls-format.ts`.
 */

import { alignsQuotes, blocksOf, columnLines, humanSize, commaLines, entryTime, indicator, isDirectoryMode, isLinkMode, longDate, longLines, parseLsArguments, parseNames, quoteName, sortEntries, startsQuoted } from '../lib/ls-format.ts'
import { colorFor, paint, parseLsColors } from '../lib/ls-colors.ts'
import { readTextFile } from './lib/fs-text.mjs'
import { basename, dirname, join, resolve } from './lib/path-utils.mjs'
import { isTty, terminalSize } from './lib/tty.mjs'
import { compile } from './lib/fnmatch.mjs'
import { strftime } from './lib/strftime.mjs'

const { argv, env, exit, writeAll, getcwd, stat, lstat, isDirectory, readdir, readlink } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: ls [OPTION]... [FILE]...
List information about the FILEs (the current directory by default), sorted by name.

  -a, --all             do not ignore entries starting with .
  -A, --almost-all      like -a, but leave out . and ..
  -b, --escape          print C-style escapes for nongraphic characters
  -c                    with -lt: sort by, and show, ctime; with -l: show ctime and sort by name
  -C                    list entries by columns
  -d, --directory       list directories themselves, not their contents
  -f                    do not sort, enable -aU, disable -ls --color
  -F, --classify        append an indicator (one of */=@|) to entries
      --file-type       likewise, except do not append '*'
      --format=WORD     across -x, commas -m, horizontal -x, long -l, single-column -1, verbose -l, vertical -C
      --full-time       like -l --time-style=full-iso
  -g                    like -l, but do not list owner
      --group-directories-first  group directories before files
  -G, --no-group        in a long listing, don't print group names
  -h, --human-readable  with -l and -s, print sizes like 1K 234M 2G
  -H                    follow symbolic links listed on the command line
  -I, --ignore=PATTERN  do not list implied entries matching shell PATTERN
  -i, --inode           print the index number of each file
  -k, --kibibytes       default to 1024-byte blocks
  -l                    use a long listing format
  -L, --dereference     when showing file information for a symbolic link, show information for the file the link references
  -m                    fill width with a comma separated list of entries
  -n, --numeric-uid-gid like -l, but list numeric user and group IDs
  -o                    like -l, but do not list group information
  -p                    append / to directories
  -q, --hide-control-chars  print ? instead of nongraphic characters
  -Q, --quote-name      enclose entry names in double quotes
  -r, --reverse         reverse order while sorting
  -R, --recursive       list subdirectories recursively
  -s, --size            print the allocated size of each file, in blocks
  -S                    sort by file size, largest first
      --sort=WORD       sort by WORD instead of name: none -U, size -S, time -t, version -v, extension -X
      --time=WORD       select which time to show and sort by: atime -u, ctime -c, mtime
      --time-style=TIME_STYLE  time/date format with -l: full-iso, long-iso, iso, locale, or +FORMAT
  -t                    sort by time, newest first
  -T, --tabsize=COLS    assume tab stops at each COLS instead of 8
  -u                    with -lt: sort by, and show, access time
  -U                    do not sort; list entries in directory order
  -v                    natural sort of (version) numbers within text
  -w, --width=COLS      set output width to COLS; 0 means no limit
  -x                    list entries by lines instead of by columns
  -X                    sort alphabetically by entry extension
  -1                    list one file per line
      --color[=WHEN]    color names by type: always (the default for --color), auto or never
      --help            display this help and exit`

const REASONS = { EACCES: 'Permission denied', ENOENT: 'No such file or directory', ENOTDIR: 'Not a directory', ELOOP: 'Too many levels of symbolic links' }
const reason = error => REASONS[error?.code] ?? (error instanceof Error ? error.message : String(error))

/** An entry for `name` inside `dir`, from `lstat` (a link is described itself, with where it points), or `stat` when links are followed. */
function describe(dir, name, follow = false) {
  const path = join(dir, name)
  let s
  let isLink = false
  if (follow) {
    try { s = stat(path) } catch { s = lstat(path) }
  } else s = lstat(path)
  const entry = { name, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, atimeMs: s.atimeMs, ctimeMs: s.ctimeMs, uid: s.uid, gid: s.gid, nlink: s.nlink ?? 1, ino: s.ino ?? 0, rdev: s.rdev ?? 0, blocks: s.blocks ?? 0 }
  if (isLinkMode(s.mode)) {
    isLink = true
    try { entry.linkTarget = readlink(path) } catch { /* shown without a target */ }
  }
  void isLink
  return entry
}

function loadNames() {
  const read = path => { try { return parseNames(readTextFile(path)) } catch { return new Map() } }
  return { users: read('/etc/passwd'), groups: read('/etc/group') }
}

const SIX_MONTHS_MS = 182.5 * 24 * 3600 * 1000

/** The date column for `--time-style` (and `--full-time`); `undefined` keeps the default of `ls -l` */
function dateFormatter(style, which, now) {
  if (style === undefined || style === 'locale') return undefined
  const utc = env?.TZ !== undefined && /^(UTC|GMT|UCT)(0)?$/.test(env.TZ)
  const at = (format, ms) => strftime(format, { ms, utc })
  const recent = ms => ms <= now && now - ms < SIX_MONTHS_MS
  let old, current
  if (style === 'full-iso') old = current = '%Y-%m-%d %H:%M:%S.%N %z'
  else if (style === 'long-iso') old = current = '%Y-%m-%d %H:%M'
  else if (style === 'iso') { old = '%Y-%m-%d '; current = '%m-%d %H:%M' }
  else if (style.startsWith('+')) {
    const [first, second] = style.slice(1).split('\n')
    old = first
    current = second ?? first
  } else return undefined
  return entry => { const ms = entryTime(entry, which); return at(recent(ms) ? current : old, ms) }
}

function main() {
  const { options, error } = parseLsArguments(argv.slice(1))
  if (error) { err(`ls: ${error}\nTry 'ls --help' for more information.`); return 2 }
  if (options.help) { out(usage + '\n'); return 0 }

  const cwd = getcwd()
  const tty = isTty(1)
  // on a terminal names are quoted for the shell unless a quoting option says otherwise
  if (tty && !options.quotingGiven) options.quoting = 'shell-escape'
  const columns = Number(env?.COLUMNS)
  const lineWidth = options.width !== undefined ? options.width : tty ? terminalSize(1).cols : Number.isInteger(columns) && columns > 0 ? columns : 80
  const format = options.format ?? (tty ? 'columns' : 'single')
  const long = format === 'long'
  const names = long ? loadNames() : { users: new Map(), groups: new Map() }
  const now = Date.now()
  const colors = options.color === 'always' || (options.color === 'auto' && tty && env?.TERM !== 'dumb') ? parseLsColors(env?.LS_COLORS) : undefined
  const paintEntry = colors ? (entry, text) => paint(text, colorFor(entry, colors)) : undefined
  const ignore = options.ignore.map(pattern => compile(pattern))
  const formatOptions = {
    human: options.human, inode: options.inode, classify: options.classify, slash: options.slash, fileType: options.fileType, blocks: options.blocks,
    numericIds: options.numericIds, hideOwner: options.hideOwner, hideGroup: options.hideGroup, quoting: options.quoting, hideControl: options.hideControl,
    time: options.time, date: dateFormatter(options.timeStyle, options.time, now), paint: paintEntry
  }
  const sortOptions = { sort: options.sort, reverse: options.reverse, time: options.time, dirsFirst: options.dirsFirst }
  let status = 0

  /** One name as the short formats show it: prefix (inode, blocks), the quoted name, the indicator */
  const parts = (entries, widthOfBlocks) => { const pad = format !== 'single' && alignsQuotes(options.quoting) && entries.some(entry => startsQuoted(quoteName(entry.name, options.quoting, options.hideControl))); return entries.map(entry => ({
    entry,
    prefix: (options.inode ? `${entry.ino} ` : '') + (options.blocks ? `${(options.human ? humanBlocks(entry) : String(blocksOf(entry))).padStart(widthOfBlocks)} ` : ''),
    name: (pad && !startsQuoted(quoteName(entry.name, options.quoting, options.hideControl)) ? ' ' : '') + quoteName(entry.name, options.quoting, options.hideControl),
    suffix: indicator(entry, options)
  })) }
  const humanBlocks = entry => longHuman(blocksOf(entry) * 1024)

  const render = (entries, withTotal) => {
    if (!entries.length) return []
    if (long) return longLines(entries, names, formatOptions, now, withTotal)
    const widthOfBlocks = options.blocks ? Math.max(...entries.map(e => (options.human ? humanBlocks(e) : String(blocksOf(e))).length)) : 0
    const items = parts(entries, widthOfBlocks)
    const labels = items.map(item => item.prefix + item.name + item.suffix)
    // only the name is colored; the inode, the block count and the indicator are not
    const shown = paintEntry ? (_, index) => { const item = items[index]; return item.prefix + paintEntry(item.entry, item.name) + item.suffix } : undefined
    const lines = []
    if (withTotal && options.blocks) {
      const blocks = entries.reduce((sum, entry) => sum + blocksOf(entry), 0)
      lines.push(`total ${options.human ? longHuman(blocks * 1024) : blocks}`)
    }
    const limit = lineWidth === 0 ? 1e9 : lineWidth
    if (format === 'commas') return lines.concat(commaLines(labels, lineWidth, shown))
    if (format === 'columns' || format === 'across') return lines.concat(columnLines(labels, limit, shown, { across: format === 'across', tabsize: options.tabsize }))
    return lines.concat(shown ? labels.map(shown) : labels)
  }

  const listDirectory = (path, label, header, top) => {
    let names_
    try { names_ = readdir(path) } catch (e) {
      err(`ls: cannot open directory '${label}': ${reason(e)}`)
      status = Math.max(status, top ? 2 : 1)
      return
    }
    if (options.all) names_ = ['.', '..', ...names_.filter(n => n !== '.' && n !== '..')]
    else if (!options.almostAll) names_ = names_.filter(n => !n.startsWith('.'))
    else names_ = names_.filter(n => n !== '.' && n !== '..')
    if (ignore.length) names_ = names_.filter(n => !ignore.some(match => match(n)))

    const entries = []
    for (const name of names_) {
      try { entries.push(describe(path, name, options.dereference === 'all')) } catch (e) {
        // an entry of /proc/N/fd can be the directory handle this very listing used, closed by the time it is looked at
        if (e?.code === 'ENOENT' && /^\/proc\/(self|\d+)\/fd\/?$/.test(path)) {
          entries.push({ name, mode: 0o120700, size: 64, mtimeMs: 0, atimeMs: 0, ctimeMs: 0, uid: 0, gid: 0, nlink: 1, ino: 0, rdev: 0, blocks: 0 })
          continue
        }
        err(`ls: cannot access '${label.replace(/\/$/, '')}/${name}': ${reason(e)}`)
        status = Math.max(status, top ? 2 : 1)
      }
    }
    const sorted = sortEntries(entries, sortOptions)
    if (header) out(`${label}:\n`)
    const lines = render(sorted, true)
    // an empty directory still gets its total under -l
    if (!lines.length && (long || options.blocks)) lines.push('total 0')
    if (lines.length) out(lines.join('\n') + '\n')

    if (options.recursive) {
      for (const entry of sorted) {
        if (entry.name === '.' || entry.name === '..' || !isDirectoryMode(entry.mode)) continue
        out('\n')
        listDirectory(join(path, entry.name), `${label.endsWith('/') ? label : label + '/'}${entry.name}`, true, false)
      }
    }
  }

  const operands = options.operands.length ? options.operands : ['.']
  const files = []
  const directories = []
  for (const operand of operands) {
    const path = resolve(cwd, operand === '' ? '.' : operand)
    let entry
    const follow = options.dereference !== 'none'
    try { entry = describe(dirname(path) === path ? path : dirname(path), basename(path) || path, follow) } catch (e) {
      err(`ls: cannot access '${operand}': ${reason(e)}`)
      status = 2
      continue
    }
    entry.name = operand
    // a link to a directory is followed unless it is being listed with -l or -d
    let isDir = isDirectoryMode(entry.mode)
    if (!isDir && isLinkMode(entry.mode) && !long && !options.directory) {
      try { isDir = isDirectory(path) } catch { isDir = false }
    }
    if (isDir && !options.directory) directories.push({ operand, path, entry })
    else files.push(entry)
  }

  let printed = false
  if (files.length) {
    out(render(sortEntries(files, sortOptions), false).join('\n') + '\n')
    printed = true
  }
  const header = operands.length > 1 || options.recursive
  const dirEntries = directories.map(d => ({ ...d, name: d.operand, mtimeMs: d.entry.mtimeMs, atimeMs: d.entry.atimeMs, ctimeMs: d.entry.ctimeMs, size: d.entry.size, mode: d.entry.mode }))
  for (const { operand, path } of sortEntries(dirEntries, { ...sortOptions, dirsFirst: false })) {
    if (printed) out('\n')
    listDirectory(path, operand, header, true)
    printed = true
  }
  return status
}

/** `1.5K` style size, shared with the long format */
function longHuman(bytes) {
  return humanSize(bytes)
}

try {
  exit(main())
} catch (error) {
  err(`ls: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
