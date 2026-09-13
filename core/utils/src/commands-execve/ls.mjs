/**
 * Real `execve`'d `ls` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/ls.ts`) per `feat/1.0.0-execve-commands`. The original read live
 * `kernel.i18n` (translated column headers), `kernel.users.all` (username lookup for uid/gid),
 * `kernel.devices` (package descriptions for device files), and `terminal.isMobile` (responsive
 * column layout) -- none of which a real, worker-hosted `execve`'d process can see, the same way a
 * real `/bin/ls` binary in a minimal container without `/etc/passwd` just prints numeric uid/gid.
 * This port simplifies accordingly: numeric uid/gid, fixed English column headers, no device-package
 * descriptions, no mobile-responsive layout, no ANSI coloring (color output isn't proven anywhere in
 * this worker pipeline yet, unlike `columnify` itself -- already used by `column.mjs`).
 */

import { resolve, join, basename, dirname } from './lib/path-utils.mjs'
import columnify from 'columnify'

const { argv, exit, writeAll, getcwd, stat, lstat, isDirectory, isSymbolicLink, readdir, readlink } = globalThis.ecmaosSyscalls

const usage = `Usage: ls [OPTION]... [FILE]...
List information about the FILEs (the current directory by default).

  --help  display this help and exit`

const S_IFMT = 0xf000
const S_IFBLK = 0x6000
const S_IFCHR = 0x2000
const S_IFIFO = 0x1000
const S_IFSOCK = 0xc000

function getModeType(mode) {
  const type = mode & S_IFMT
  if (isDirectoryMode(mode)) return 'd'
  if (type === S_IFBLK) return 'b'
  if (type === S_IFCHR) return 'c'
  if (type === S_IFIFO) return 'p'
  if (type === S_IFSOCK) return 's'
  return '-'
}

function isDirectoryMode(mode) {
  return (mode & S_IFMT) === 0x4000
}

function getModeString(mode, isLink) {
  const type = isLink ? 'l' : getModeType(mode)
  const permissions = (mode & 0o777).toString(8).padStart(3, '0')
    .replace(/0/g, '---')
    .replace(/1/g, '--x')
    .replace(/2/g, '-w-')
    .replace(/3/g, '-wx')
    .replace(/4/g, 'r--')
    .replace(/5/g, 'r-x')
    .replace(/6/g, 'rw-')
    .replace(/7/g, 'rwx')
  return type + permissions
}

function formatTimestamp(mtimeMs) {
  return new Date(mtimeMs).toISOString().slice(0, 19).replace('T', ' ')
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  const units = ['K', 'M', 'G', 'T']
  let value = bytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)}${units[unitIndex]}`
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const cwd = getcwd()
  const targets = args.length > 0 ? args.filter(arg => !arg.startsWith('-')) : [cwd]
  if (targets.length === 0) targets.push(cwd)

  const allEntries = []

  for (const target of targets) {
    const fullPath = resolve(cwd, target === '' ? '.' : target)
    try {
      if (isDirectory(fullPath)) {
        const entries = readdir(fullPath)
        for (const entry of entries) allEntries.push({ fullPath, entry })
      } else {
        allEntries.push({ fullPath: dirname(fullPath), entry: basename(fullPath) })
      }
    } catch {
      // target doesn't exist -- skip it, matching standard ls behavior
      continue
    }
  }

  const describe = ({ fullPath, entry }) => {
    const target = join(fullPath, entry)
    try {
      const linkStats = lstat(target)
      const isLink = isSymbolicLink(target)
      let targetStats = linkStats
      let linkTarget = null

      if (isLink) {
        try {
          linkTarget = readlink(target)
          targetStats = stat(target)
        } catch {
          targetStats = linkStats
        }
      }

      return { target, name: entry, stats: targetStats, isLink, linkTarget }
    } catch {
      return { target, name: entry, stats: null, isLink: false, linkTarget: null }
    }
  }

  const described = allEntries.map(describe)

  const directories = described
    .filter(e => e.stats && isDirectoryMode(e.stats.mode))
    .filter((e, index, self) => self.findIndex(o => o.name === e.name) === index)

  const files = described.filter(e => e.stats && !isDirectoryMode(e.stats.mode))

  const columns = ['Name', 'Size', 'Modified', 'Mode', 'Owner']

  const toRow = (entry) => {
    const displayName = entry.linkTarget ? `${entry.name} -> ${entry.linkTarget}` : entry.name
    const modeString = entry.stats ? getModeString(entry.stats.mode, entry.isLink) : ''
    const isDir = entry.stats ? isDirectoryMode(entry.stats.mode) : false

    return {
      Name: displayName,
      Size: isDir ? '' : (entry.stats ? formatSize(entry.stats.size) : ''),
      Modified: entry.stats ? formatTimestamp(entry.stats.mtimeMs) : '',
      Mode: modeString,
      Owner: entry.stats ? `${entry.stats.uid}:${entry.stats.gid}` : ''
    }
  }

  const directoryRows = directories.sort((a, b) => a.name.localeCompare(b.name)).map(toRow)
  const fileRows = files.sort((a, b) => a.name.localeCompare(b.name)).map(toRow)
  const data = [...directoryRows, ...fileRows]

  if (data.length > 0) {
    const table = columnify(data, { columns, columnSplitter: '  ', showHeaders: true })
    writeAll(1, new TextEncoder().encode(table + '\n'))
  }

  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`ls: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
