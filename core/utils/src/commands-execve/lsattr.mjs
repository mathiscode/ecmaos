/** `lsattr`: list the file attributes `chattr` sets, as e2fsprogs's lsattr does (`-a`, `-d`, `-R`, `-l`, `-v`). */

import { reasonOf } from './lib/errno.mjs'
import { getFlags, longForm, shortForm } from './lib/file-attrs.mjs'
import { getopt } from './lib/getopt.mjs'

const { argv, exit, open, close, lstat, readdir, writeAll, O_RDONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`lsattr: ${text}\n`))

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

const usage = 'Usage: lsattr [-RVadlpv] [files...]\n'

let all = false, dirsAsFiles = false, recursive = false, long = false, version = false
let status = 0

function show(path) {
  let fd
  try { fd = open(path, O_RDONLY) } catch (e) { err(`${reasonOf(e)} While reading flags on ${path}`); status = 1; return }
  try {
    const flags = getFlags(fd)
    const generation = version ? `${String(0).padStart(5)} ` : ''
    out(long ? `${generation}${path.padEnd(28)} ${longForm(flags)}\n` : `${generation}${shortForm(flags)} ${path}\n`)
  } catch (e) {
    err(`${reasonOf(e)} While reading flags on ${path}`)
    status = 1
  } finally { close(fd) }
}

function listDirectory(dir) {
  let names
  try { names = readdir(dir) } catch (e) { err(`${reasonOf(e)} While reading ${dir}`); status = 1; return }
  names = names.filter(name => name !== '.' && name !== '..' && (all || !name.startsWith('.'))).sort()
  const join = name => dir === '/' ? `/${name}` : `${dir}/${name}`
  for (const name of names) {
    const path = join(name)
    let mode = 0
    try { mode = Number(lstat(path).mode) } catch {}
    if ((mode & S_IFMT) === S_IFLNK) continue
    show(path)
  }
  if (!recursive) return
  for (const name of names) {
    const path = join(name)
    let mode = 0
    try { mode = Number(lstat(path).mode) } catch {}
    if ((mode & S_IFMT) !== S_IFDIR) continue
    out(`\n${path}:\n`)
    listDirectory(path)
  }
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'RVadlpv', long: { help: 'h' } })
  if (error) { err(error); writeAll(2, encoder.encode(usage)); return 1 }
  for (const [key] of options) {
    if (key === 'h') { out(usage); return 0 }
    if (key === 'V') { out('lsattr 1.47.2 (ecmaOS)\n'); return 0 }
    if (key === 'a') all = true
    else if (key === 'd') dirsAsFiles = true
    else if (key === 'R') recursive = true
    else if (key === 'l') long = true
    else if (key === 'v') version = true
  }
  if (!operands.length) { listDirectory('.'); return status }
  for (const path of operands) {
    let mode
    try { mode = Number(lstat(path).mode) } catch (e) { err(`${reasonOf(e)} while trying to stat ${path}`); status = 1; continue }
    if ((mode & S_IFMT) === S_IFDIR && !dirsAsFiles) listDirectory(path.replace(/(.)\/+$/, '$1'))
    else show(path)
  }
  return status
}

exit(main())
