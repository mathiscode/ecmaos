/**
 * List directory contents, as GNU `ls` does: names (in columns on a terminal, one per line otherwise),
 * `-l` for the long format with owner and group names read from /etc/passwd and /etc/group, and the
 * usual -a -A -d -h -R -r -t -S -U -F -p -i -1 flags. The formatting lives in `lib/ls-format.ts`.
 */

import { columnLines, isDirectoryMode, isLinkMode, longLines, parseLsArguments, parseNames, sortEntries, indicator } from '../lib/ls-format.ts'
import { readTextFile } from './lib/fs-text.mjs'
import { basename, dirname, join, resolve } from './lib/path-utils.mjs'
import { isTty, terminalSize } from './lib/tty.mjs'

const { argv, exit, writeAll, getcwd, stat, lstat, isDirectory, readdir, readlink } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: ls [OPTION]... [FILE]...
List information about the FILEs (the current directory by default), sorted by name.

  -a, --all             do not ignore entries starting with .
  -A, --almost-all      like -a, but leave out . and ..
  -d, --directory       list directories themselves, not their contents
  -F, --classify        append an indicator (one of */=@|) to entries
  -p                    append / to directories
  -h, --human-readable  with -l, print sizes like 1K 234M 2G
  -i, --inode           print the inode number of each file
  -l                    use a long listing format
  -1                    list one file per line
  -r, --reverse         reverse the order while sorting
  -R, --recursive       list subdirectories recursively
  -S                    sort by file size, largest first
  -t                    sort by modification time, newest first
  -U                    do not sort; list in directory order
  --help                display this help and exit`

const REASONS = { EACCES: 'Permission denied', ENOENT: 'No such file or directory', ENOTDIR: 'Not a directory', ELOOP: 'Too many levels of symbolic links' }
const reason = error => REASONS[error?.code] ?? (error instanceof Error ? error.message : String(error))

/** An entry for `name` inside `dir`, from `lstat` (a link is described itself, with where it points). */
function describe(dir, name) {
  const path = join(dir, name)
  const s = lstat(path)
  const entry = { name, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, uid: s.uid, gid: s.gid, nlink: s.nlink ?? 1, ino: s.ino ?? 0, rdev: s.rdev ?? 0, blocks: s.blocks ?? 0 }
  if (isLinkMode(s.mode)) {
    try { entry.linkTarget = readlink(path) } catch { /* shown without a target */ }
  }
  return entry
}

function loadNames() {
  const read = path => { try { return parseNames(readTextFile(path)) } catch { return new Map() } }
  return { users: read('/etc/passwd'), groups: read('/etc/group') }
}

function main() {
  const { options, error } = parseLsArguments(argv.slice(1))
  if (error) { err(`ls: ${error}\nTry 'ls --help' for more information.`); return 2 }
  if (options.help) { out(usage + '\n'); return 0 }

  const cwd = getcwd()
  const tty = isTty(1)
  const width = tty ? terminalSize(1).cols : 80
  const names = options.long ? loadNames() : { users: new Map(), groups: new Map() }
  const now = Date.now()
  const format = { human: options.human, inode: options.inode, classify: options.classify, slash: options.slash }
  let status = 0

  const labelOf = entry => (options.inode ? `${entry.ino} ` : '') + entry.name + indicator(entry, options)
  const render = (entries, withTotal) => {
    if (!entries.length) return []
    if (options.long) return longLines(entries, names, format, now, withTotal)
    const labels = entries.map(labelOf)
    return options.oneColumn || !tty ? labels : columnLines(labels, width)
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

    const entries = []
    for (const name of names_) {
      try { entries.push(describe(path, name)) } catch (e) {
        err(`ls: cannot access '${join(label, name)}': ${reason(e)}`)
        status = Math.max(status, top ? 2 : 1)
      }
    }
    const sorted = sortEntries(entries, options)
    if (header) out(`${label}:\n`)
    const lines = render(sorted, true)
    if (lines.length) out(lines.join('\n') + '\n')

    if (options.recursive) {
      for (const entry of sorted) {
        if (entry.name === '.' || entry.name === '..' || !isDirectoryMode(entry.mode)) continue
        out('\n')
        listDirectory(join(path, entry.name), join(label, entry.name), true, false)
      }
    }
  }

  const operands = options.operands.length ? options.operands : ['.']
  const files = []
  const directories = []
  for (const operand of operands) {
    const path = resolve(cwd, operand === '' ? '.' : operand)
    let entry
    try { entry = describe(dirname(path) === path ? path : dirname(path), basename(path) || path) } catch (e) {
      err(`ls: cannot access '${operand}': ${reason(e)}`)
      status = 2
      continue
    }
    entry.name = operand
    // a link to a directory is followed unless it is being listed with -l or -d
    let isDir = isDirectoryMode(entry.mode)
    if (!isDir && isLinkMode(entry.mode) && !options.long && !options.directory) {
      try { isDir = isDirectory(path) } catch { isDir = false }
    }
    if (isDir && !options.directory) directories.push({ operand, path, entry })
    else files.push(entry)
  }

  let printed = false
  if (files.length) {
    out(render(sortEntries(files, options), false).join('\n') + '\n')
    printed = true
  }
  const header = operands.length > 1 || options.recursive
  for (const { operand, path } of sortEntries(directories.map(d => ({ ...d, name: d.operand, mtimeMs: d.entry.mtimeMs, size: d.entry.size })), options)) {
    if (printed) out('\n')
    listDirectory(path, operand, header, true)
    printed = true
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(`ls: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
