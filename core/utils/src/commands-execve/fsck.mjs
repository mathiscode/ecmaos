/**
 * Checks the root filesystem for the damage two tabs sharing one store leave behind (`fsck`, `fsck --read`). Reports
 * only. Checks: a directory entry that cannot be examined, one inode number shared by entries that are not hard
 * links, a directory reached twice, and with `--read` a file whose data cannot be read or is shorter than its inode
 * says. Other mounts (/proc, /sys, /dev, /tmp, /media, /mnt) are skipped.
 */

import { join, resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, lstat, readdir, open, read, close, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const say = text => writeAll(1, encoder.encode(text + '\n'))
const err = text => writeAll(2, encoder.encode(`fsck: ${text}\n`))
const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFREG = 0x8000
const S_IFLNK = 0xa000
const OtherMounts = new Set(['/proc', '/sys', '/dev', '/tmp', '/media', '/mnt'])

const usage = `Usage: fsck [OPTION]... [DIRECTORY]
Check the root filesystem (or DIRECTORY) for entries that cannot be examined, inode numbers shared by unrelated files, and
directories reached twice. It only reports; nothing is repaired.

  -r, --read    also read every regular file and compare its length with what its inode says (slow on a big machine)
  -q, --quiet   print only the problems
  --help        display this help and exit

Exit status: 0 when nothing is wrong, 4 when problems were found, 8 when the check could not run.`

const kind = mode => (mode & S_IFMT) === S_IFDIR ? 'directory' : (mode & S_IFMT) === S_IFREG ? 'file' : (mode & S_IFMT) === S_IFLNK ? 'symlink' : 'special'

function main() {
  const args = argv.slice(1)
  const options = { read: false, quiet: false }
  const roots = []
  for (const arg of args) {
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-r' || arg === '--read') options.read = true
    else if (arg === '-q' || arg === '--quiet') options.quiet = true
    else if (arg.startsWith('-') && arg !== '-') { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); return 8 }
    else roots.push(arg)
  }
  if (roots.length > 1) { err('one directory at a time'); return 8 }
  const start = resolve(getcwd(), roots[0] ?? '/')

  const problems = []
  const owners = new Map() // ino -> [{ path, mode, nlink }]
  const directories = new Map() // ino -> path
  let files = 0
  let dirs = 0

  const checkData = (path, info) => {
    let fd
    try { fd = open(path, O_RDONLY) } catch (error) { problems.push(`${path}: cannot be opened (${error?.message ?? error})`); return }
    try {
      const buffer = new Uint8Array(65536)
      let total = 0
      for (;;) {
        const n = read(fd, buffer, -1)
        if (n <= 0) break
        total += n
      }
      if (total !== Number(info.size)) problems.push(`${path}: the inode says ${info.size} bytes and ${total} can be read`)
    } catch (error) {
      problems.push(`${path}: data cannot be read (${error?.message ?? error})`)
    } finally {
      try { close(fd) } catch { /* nothing to close */ }
    }
  }

  const walk = path => {
    if (OtherMounts.has(path)) return
    let info
    try { info = lstat(path) } catch (error) { problems.push(`${path}: entry cannot be examined (${error?.message ?? error})`); return }
    const ino = Number(info.ino ?? 0)
    const type = kind(info.mode)
    if (ino) {
      const list = owners.get(ino) ?? []
      list.push({ path, type, nlink: Number(info.nlink ?? 1) })
      owners.set(ino, list)
    }
    if (type === 'directory') {
      dirs++
      if (ino && directories.has(ino)) { problems.push(`${path}: the same directory as ${directories.get(ino)} (inode ${ino}), reached twice`); return }
      if (ino) directories.set(ino, path)
      let names
      try { names = readdir(path).filter(name => name !== '.' && name !== '..').sort() } catch (error) { problems.push(`${path}: directory cannot be read (${error?.message ?? error})`); return }
      for (const name of names) walk(path === '/' ? `/${name}` : join(path, name))
    } else {
      files++
      if (options.read && type === 'file') checkData(path, info)
    }
  }

  walk(start)

  for (const [ino, list] of owners) {
    if (list.length < 2) continue
    const types = new Set(list.map(item => item.type))
    const names = list.map(item => item.path).join(', ')
    if (types.size > 1) problems.push(`inode ${ino} is used by entries of different kinds: ${names}`)
    else if (!types.has('directory') && list.every(item => item.nlink <= 1)) problems.push(`inode ${ino} is shared by ${list.length} entries that are not linked to each other: ${names}`)
  }

  for (const problem of problems) say(problem)
  if (problems.length === 0) {
    if (!options.quiet) say(`fsck: ${dirs} directories and ${files} other entries checked${options.read ? ', file data read' : ''}; no problems found`)
    return 0
  }
  err(`${problems.length} problem${problems.length === 1 ? '' : 's'} found in ${dirs} directories and ${files} other entries; nothing was changed`)
  return 4
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(8)
}
