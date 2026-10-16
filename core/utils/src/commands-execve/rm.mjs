/**
 * Remove files and directories, as GNU `rm` does. The operands are exactly what the shell expanded (no globbing here,
 * so a quoted `'*'` is a file named `*`), symlinks are removed and never followed, `.` and `..` are refused, and `/`
 * is protected unless `--no-preserve-root`. `-r` removes a tree depth first; `-d` removes an empty directory;
 * `-i` and `-I` ask first; `-f` ignores a missing operand and never asks.
 */

import { resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, is } from './lib/errno.mjs'

const { argv, exit, writeAll, read, getcwd, lstat, unlink, rmdir, readdir } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`rm: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('rm') + '\n'))

const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFLNK = 0xa000

const usage = `Usage: rm [OPTION]... [FILE]...
Remove (unlink) the FILE(s).

  -f, --force           ignore nonexistent files and arguments, never prompt
  -i                    prompt before every removal
  -I                    prompt once before removing more than three files, or
                          when removing recursively
      --one-file-system  accepted; the file system is not crossed here
      --no-preserve-root  do not treat '/' specially
      --preserve-root[=all]  do not remove '/' (default)
  -r, -R, --recursive   remove directories and their contents recursively
  -d, --dir             remove empty directories
  -v, --verbose         explain what is being done
      --help            display this help and exit

By default, rm does not remove directories.  Use the --recursive (-r or -R)
option to remove each listed directory, too, along with all of its contents.`

/** One line from fd 0, for the prompts of -i and -I */
function answer() {
  const byte = new Uint8Array(1)
  let line = ''
  for (;;) {
    if (read(0, byte, -1) <= 0) break
    if (byte[0] === 10) break
    line += String.fromCharCode(byte[0])
  }
  return /^y/i.test(line)
}

const kindOf = mode => ((mode & S_IFMT) === S_IFDIR ? 'directory' : (mode & S_IFMT) === S_IFLNK ? 'symbolic link' : 'regular file')

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'fiIrRdv',
    long: {
      force: 'f', interactive: { key: 'i', arg: 'optional' }, recursive: 'r', dir: 'd', verbose: 'v', help: 'help',
      'one-file-system': 'x', 'no-preserve-root': 'N', 'preserve-root': { key: 'P', arg: 'optional' }
    }
  })
  if (error) { err(error); hint(); return 1 }
  let force = false
  let prompt = 'never'
  let recursive = false
  let dirs = false
  let verbose = false
  let preserveRoot = true
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 'f') { force = true; prompt = 'never' }
    else if (key === 'i') {
      // --interactive[=WHEN]: never, once, always
      if (value === true || value === 'always' || value === 'yes') prompt = 'always'
      else if (value === 'once') prompt = 'once'
      else if (value === 'never' || value === 'no' || value === 'none') prompt = 'never'
      else { err(`invalid argument '${value}' for '--interactive'`); hint(); return 1 }
      force = false
    } else if (key === 'I') { prompt = 'once'; force = false }
    else if (key === 'r' || key === 'R') recursive = true
    else if (key === 'd') dirs = true
    else if (key === 'v') verbose = true
    else if (key === 'N') preserveRoot = false
    else if (key === 'P') preserveRoot = true
  }

  if (operands.length === 0) {
    if (force) return 0
    err('missing operand')
    hint()
    return 1
  }

  const cwd = getcwd()
  let failed = false
  const fail = (name, text) => { err(`cannot remove '${name}': ${text}`); failed = true }

  if (prompt === 'once' && (operands.length > 3 || recursive)) {
    writeAll(2, encoder.encode(`rm: remove ${operands.length} argument${operands.length === 1 ? '' : 's'}${recursive ? ' recursively' : ''}? `))
    if (!answer()) return 0
  }

  /** Remove `path` (shown as `name`); returns true when it is gone */
  const remove = (name, path, top) => {
    let stats
    try { stats = lstat(path) } catch (error) {
      if (!(top && force && (is(error, 'ENOENT') || is(error, 'ENOTDIR')))) fail(name, reasonOf(error))
      return false
    }
    const isDir = (stats.mode & S_IFMT) === S_IFDIR
    // a trailing slash names what a symlink points at, never the link itself or a file
    if (top && !isDir && /\/$/.test(name)) { fail(name, 'Not a directory'); return false }
    if (isDir && !recursive) {
      if (!dirs) { fail(name, 'Is a directory'); return false }
      if (prompt === 'always') {
        writeAll(2, encoder.encode(`rm: remove directory '${name}'? `))
        if (!answer()) return false
      }
      try { rmdir(path) } catch (error) { fail(name, reasonOf(error)); return false }
      if (verbose) out(`removed directory '${name}'\n`)
      return true
    }
    if (isDir) {
      if (prompt === 'always') {
        writeAll(2, encoder.encode(`rm: descend into directory '${name}'? `))
        if (!answer()) return false
      }
      let names
      try { names = readdir(path) } catch (error) { fail(name, reasonOf(error)); return false }
      let clean = true
      for (const entry of names) if (!remove(`${name.replace(/\/+$/, '')}/${entry}`, `${path}/${entry}`, false)) clean = false
      if (!clean) return false
      if (prompt === 'always') {
        writeAll(2, encoder.encode(`rm: remove directory '${name}'? `))
        if (!answer()) return false
      }
      try { rmdir(path) } catch (error) { fail(name, reasonOf(error)); return false }
      if (verbose) out(`removed directory '${name}'\n`)
      return true
    }
    if (prompt === 'always') {
      writeAll(2, encoder.encode(`rm: remove ${kindOf(stats.mode)} '${name}'? `))
      if (!answer()) return false
    }
    try { unlink(path) } catch (error) { fail(name, reasonOf(error)); return false }
    if (verbose) out(`removed '${name}'\n`)
    return true
  }

  for (const operand of operands) {
    const trimmed = operand.replace(/\/+$/, '') || (operand ? '/' : '')
    const last = trimmed.slice(trimmed.lastIndexOf('/') + 1)
    if (last === '.' || last === '..') {
      err(`refusing to remove '.' or '..' directory: skipping '${operand}'`)
      failed = true
      continue
    }
    const path = resolve(cwd, operand)
    if (preserveRoot && path === '/' && (recursive || dirs)) {
      err("it is dangerous to operate recursively on '/'")
      err('use --no-preserve-root to override this failsafe')
      failed = true
      continue
    }
    remove(operand, path, true)
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
