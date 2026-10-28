/**
 * `chattr`: change the file attributes `lsattr` shows, as e2fsprogs's chattr does: `+` adds, `-` takes away and `=`
 * sets exactly the attributes named, on each file, with `-R` through directories (not following symbolic links). Only
 * root sets or clears `i` (immutable) and `a` (append-only), which the filesystem then keeps even from root.
 */

import { reasonOf } from './lib/errno.mjs'
import { bitOf, getFlags, setFlags, shortForm } from './lib/file-attrs.mjs'

const { argv, exit, open, close, lstat, readdir, writeAll, O_RDONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`chattr: ${text}\n`))

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

const usage = 'Usage: chattr [-RVf] [-+=aAcCdDeFijmPsStTux] [-v version] files...\n'

function main() {
  let recursive = false, verbose = false, force = false
  let add = 0, remove = 0, set
  const files = []
  const args = argv.slice(1)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (files.length || !/^[-+=]/.test(arg) || arg === '-' ) { files.push(arg); continue }
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { out(usage); return 0 }
    if (arg === '-v' || arg === '-p') {
      // the generation and the project are not kept here; the number is read and set aside
      if (i + 1 >= args.length || !/^\d+$/.test(args[i + 1])) { err(`bad ${arg === '-v' ? 'version' : 'project'} - ${args[i + 1] ?? ''}`); writeAll(2, encoder.encode(usage)); return 1 }
      i++
      continue
    }
    const op = arg[0]
    let bits = 0
    for (const letter of arg.slice(1)) {
      if (op === '-' && 'RVf'.includes(letter)) {
        if (letter === 'R') recursive = true
        else if (letter === 'V') verbose = true
        else force = true
        continue
      }
      const bit = bitOf(letter)
      if (bit === undefined) { err(`invalid mode: ${arg}`); writeAll(2, encoder.encode(usage)); return 1 }
      bits |= bit
    }
    if (op === '+') add |= bits
    else if (op === '-') remove |= bits
    else set = (set ?? 0) | bits
  }
  if (set === undefined && !add && !remove) { err('must use \'-v\', =, - or +'); writeAll(2, encoder.encode(usage)); return 1 }
  if (set !== undefined && (add || remove)) { err('= is incompatible with - and +'); return 1 }
  if (!files.length) { writeAll(2, encoder.encode(usage)); return 1 }

  let status = 0
  const change = (path, top) => {
    let mode
    try { mode = Number(lstat(path).mode) } catch (e) { if (!force) err(`${reasonOf(e)} while trying to stat ${path}`); status = 1; return }
    // a link is changed where it is named, and passed by in a walk
    if ((mode & S_IFMT) === S_IFLNK && !top) return
    let fd
    try { fd = open(path, O_RDONLY) } catch (e) { if (!force) err(`${reasonOf(e)} while trying to open ${path}`); status = 1; return }
    try {
      const before = getFlags(fd)
      const after = set !== undefined ? set : (before | add) & ~remove
      if (verbose) out(`Flags of ${path} set as ${shortForm(after)}\n`)
      if (after !== before) setFlags(fd, after)
    } catch (e) {
      if (!force) err(`${reasonOf(e)} while setting flags on ${path}`)
      status = 1
    } finally { close(fd) }
    if (recursive && (mode & S_IFMT) === S_IFDIR) {
      let names = []
      try { names = readdir(path) } catch (e) { if (!force) err(`${reasonOf(e)} while reading ${path}`); status = 1 }
      for (const name of names.filter(name => name !== '.' && name !== '..').sort()) change(path === '/' ? `/${name}` : `${path}/${name}`, false)
    }
  }
  for (const file of files) change(file, true)
  return status
}

exit(main())
