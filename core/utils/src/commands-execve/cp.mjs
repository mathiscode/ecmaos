/**
 * Copy files and directories, as GNU `cp` does. A file is never copied onto itself (that would truncate it), a
 * directory is never copied into itself (that would recurse for ever), a directory needs `-r`, and symlinks are
 * followed unless `-r`, `-P`, `-d` or `-a` say otherwise (then they are copied as symlinks). A new file or directory
 * gets its source's permission bits (the umask applies); an existing destination keeps its own mode. `-p` keeps the
 * mode with its special bits, the times, and the owner (the owner only when the caller may chown).
 */

import { resolve, join, basename, dirname } from './lib/path-utils.mjs'
import { chmodOwned, chownOwned, utimesOwned } from './lib/owner-ops.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, is } from './lib/errno.mjs'
import { backupName, backupOptions, backupSettings, backupUsage } from './lib/backup.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, read, getcwd, stat, lstat, readdir, mkdir, copyFile, readlink, symlink, link, unlink, rename } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`cp: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('cp') + '\n'))

const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFLNK = 0xa000

const usage = `Usage: cp [OPTION]... [-T] SOURCE DEST
  or:  cp [OPTION]... SOURCE... DIRECTORY
  or:  cp [OPTION]... -t DIRECTORY SOURCE...
Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.

  -a, --archive         same as -dR --preserve=all
  -d                    same as --no-dereference --preserve=links
  -f, --force           if an existing destination file cannot be opened, remove it and try again
  -i, --interactive     prompt before overwrite
  -l, --link            hard link files instead of copying
  -L, --dereference     always follow symbolic links in SOURCE
  -n, --no-clobber      do not overwrite an existing file
  -P, --no-dereference  never follow symbolic links in SOURCE
  -p                    same as --preserve=mode,ownership,timestamps
      --preserve[=ATTR_LIST]  preserve the specified attributes
      --parents         use full source file name under DIRECTORY
  -R, -r, --recursive   copy directories recursively
  -s, --symbolic-link   make symbolic links instead of copying
${backupUsage}
  -t, --target-directory=DIRECTORY  copy all SOURCE arguments into DIRECTORY
  -T, --no-target-directory  treat DEST as a normal file
  -u, --update          copy only when the SOURCE file is newer than the destination file or the destination is missing
  -v, --verbose         explain what is being done
      --help            display this help and exit`

const kind = stats => stats.mode & S_IFMT

const tryStat = (path, follow = true) => { try { return (follow ? stat : lstat)(path) } catch { return null } }
const same = (a, b) => a && b && String(a.dev) === String(b.dev) && a.ino === b.ino

/** One line from fd 0, for -i */
function answer() {
  const byte = new Uint8Array(1)
  let line = ''
  for (;;) {
    if (read(0, byte, -1) <= 0 || byte[0] === 10) break
    line += String.fromCharCode(byte[0])
  }
  return /^y/i.test(line)
}

/** Keeps what `-p` asks for: the whole mode, and the owner when this caller is allowed to give it. */
async function preserve(stats, destPath) {
  // the owner first: changing it clears the setuid and setgid bits, which the mode then puts back
  try { await chownOwned(sys, destPath, stats.uid, stats.gid) } catch { /* only root may give a file away */ }
  await chmodOwned(sys, destPath, stats.mode & 0o7777)
  // last, since writing into a directory changes its times
  // seconds, as Node's `utimes` takes them (the upstream wrapper's comment says milliseconds; it is not)
  await utimesOwned(sys, destPath, stats.atimeMs / 1000, stats.mtimeMs / 1000)
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'adfiLlnPpRrsTt:uvHx' + backupOptions.short,
    long: {
      archive: 'a', force: 'f', interactive: 'i', link: 'l', dereference: 'L', 'no-clobber': 'n', 'no-dereference': 'P',
      preserve: { key: 'preserve', arg: 'optional' }, 'no-preserve': { key: 'no-preserve', arg: 'required' },
      recursive: 'r', 'symbolic-link': 's', 'target-directory': { key: 't', arg: 'required' }, 'no-target-directory': 'T',
      update: 'u', verbose: 'v', 'one-file-system': 'x', 'parents': 'parents', help: 'help', ...backupOptions.long
    }
  })
  if (error) { err(error); hint(); return 1 }

  let recursive = false, force = false, interactive = false, noClobber = false, update = false, verbose = false
  let keep = false, linkFiles = false, symbolicLinks = false, noTargetDir = false
  let deref = 'default'
  let targetDir
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 'a') { recursive = true; deref = 'none'; keep = true }
    else if (key === 'd' || key === 'P') deref = 'none'
    else if (key === 'L') deref = 'all'
    else if (key === 'H') deref = 'cmdline'
    else if (key === 'f') { force = true; interactive = false }
    else if (key === 'i') { interactive = true; noClobber = false }
    else if (key === 'n') { noClobber = true; interactive = false }
    else if (key === 'l') linkFiles = true
    else if (key === 's') symbolicLinks = true
    else if (key === 'p') keep = true
    else if (key === 'preserve') keep = value === true || value !== ''
    else if (key === 'r' || key === 'R') recursive = true
    else if (key === 'T') noTargetDir = true
    else if (key === 't') targetDir = value
    else if (key === 'u') update = true
    else if (key === 'v') verbose = true
  }
  if (deref === 'default') deref = recursive ? 'none' : 'all'
  const backup = backupSettings(options)
  if (backup.error) { err(backup.error); hint(); return 1 }
  const parents = options.some(([key]) => key === 'parents')
  if (targetDir !== undefined && noTargetDir) { err('cannot combine --target-directory (-t) and --no-target-directory (-T)'); return 1 }

  const cwd = getcwd()
  let sources = operands
  let destination
  if (targetDir !== undefined) {
    if (sources.length === 0) { err('missing file operand'); hint(); return 1 }
    destination = targetDir
    if (kind(tryStat(resolve(cwd, destination)) ?? { mode: 0 }) !== S_IFDIR) { err(`target '${destination}' is not a directory`); return 1 }
  } else {
    if (sources.length === 0) { err('missing file operand'); hint(); return 1 }
    if (sources.length === 1) { err(`missing destination file operand after '${sources[0]}'`); hint(); return 1 }
    destination = sources[sources.length - 1]
    sources = sources.slice(0, -1)
  }
  const destPath = resolve(cwd, destination)
  const destStats = tryStat(destPath)
  const destIsDir = Boolean(destStats) && kind(destStats) === S_IFDIR
  if (noTargetDir && sources.length > 1) { err(`extra operand '${sources[1]}'`); hint(); return 1 }
  if (!noTargetDir && targetDir === undefined && sources.length > 1 && !destIsDir) { err(`target '${destination}' is not a directory`); return 1 }
  const into = !noTargetDir && destIsDir
  if (parents && !destIsDir) { err(`target '${destination}' is not a directory`); return 1 }

  let failed = false
  const fail = text => { err(text); failed = true }

  /** Copy `src` (shown as `srcName`) to `dst` (shown as `dstName`); `top` is a command-line operand */
  const copy = async (src, dst, srcName, dstName, top) => {
    let lstats, stats
    let asLink = false
    try {
      lstats = lstat(src)
      asLink = kind(lstats) === S_IFLNK && (deref === 'none' || (deref === 'cmdline' && !top))
      stats = asLink ? lstats : stat(src)
    } catch (error) { fail(`cannot stat '${srcName}': ${reasonOf(error)}`); return }
    const existing = tryStat(dst, false)

    if (asLink) {
      if (existing && noClobber) return
      if (existing && interactive) {
        writeAll(2, encoder.encode(`cp: overwrite '${dstName}'? `))
        if (!answer()) { fail(`not replacing '${dstName}'`); return }
      }
      try {
        if (existing) unlink(dst)
        symlink(readlink(src), dst)
      } catch (error) { fail(`cannot create symbolic link '${dstName}': ${reasonOf(error)}`); return }
      if (verbose) out(`'${srcName}' -> '${dstName}'\n`)
      return
    }

    if (kind(stats) === S_IFDIR) {
      if (!recursive) { fail(`-r not specified; omitting directory '${srcName}'`); return }
      if (dst === src || dst.startsWith(src === '/' ? '/' : src + '/')) {
        fail(`cannot copy a directory, '${srcName}', into itself, '${dstName}'`)
        return
      }
      const destExisting = existing && kind(tryStat(dst) ?? existing) === S_IFDIR ? tryStat(dst) : null
      if (existing && !destExisting) { fail(`cannot overwrite non-directory '${dstName}' with directory '${srcName}'`); return }
      const mode = stats.mode & 0o777
      if (!destExisting) {
        try {
          // owner rwx while the contents go in, so a read-only source directory can still be filled
          mkdir(dst, mode | 0o700)
        } catch (error) { fail(`cannot create directory '${dstName}': ${reasonOf(error)}`); return }
        if (verbose) out(`'${srcName}' -> '${dstName}'\n`)
      }
      let names
      try { names = readdir(src) } catch (error) { fail(`cannot access '${srcName}': ${reasonOf(error)}`); return }
      for (const name of names) await copy(join(src, name), join(dst, name), `${srcName.replace(/\/+$/, '')}/${name}`, `${dstName.replace(/\/+$/, '')}/${name}`, false)
      try {
        if (keep) await preserve(stats, dst)
        else if (!destExisting && (mode | 0o700) !== mode) await chmodOwned(sys, dst, mode)
      } catch (error) { fail(`failed to preserve attributes for '${dstName}': ${reasonOf(error)}`) }
      return
    }

    // A file
    const destStats = existing ? tryStat(dst) : null
    if (existing && destStats && kind(destStats) === S_IFDIR) { fail(`cannot overwrite directory '${dstName}' with non-directory '${srcName}'`); return }
    if (existing && noClobber) return
    if (destStats && same(stats, destStats)) {
      if (linkFiles && !force) return
      fail(`'${srcName}' and '${dstName}' are the same file`)
      return
    }
    if (existing) {
      if (noClobber) return
      if (update && destStats && destStats.mtimeMs >= stats.mtimeMs) return
      if (interactive) {
        writeAll(2, encoder.encode(`cp: overwrite '${dstName}'? `))
        if (!answer()) { fail(`not replacing '${dstName}'`); return }
      }
    }
    try {
      if (existing && backup.control !== 'none') {
        const saved = backupName(dst, backup, readdir)
        if (saved) rename(dst, saved)
      }
      if (linkFiles || symbolicLinks) {
        if (existing && backup.control === 'none') unlink(dst)
        if (linkFiles) link(src, dst)
        else if (srcName.startsWith('/')) symlink(srcName, dst)
        else if (dirname(dst) === cwd) symlink(srcName, dst)
        else { fail(`cannot create symbolic link '${dstName}': can make relative symbolic links only in current directory`); return }
      } else {
        try {
          // the mode only matters for a file that does not exist yet; an older @zenfs/core also checks it as access to one that does
          copyFile(src, dst, existing ? 0o644 : stats.mode & 0o777)
        } catch (error) {
          if (!(force && existing && (is(error, 'EACCES') || is(error, 'EPERM')))) throw error
          unlink(dst)
          copyFile(src, dst, stats.mode & 0o777)
        }
        if (keep) await preserve(stats, dst)
      }
    } catch (error) {
      fail(`cannot ${existing ? 'create regular file' : 'create regular file'} '${dstName}': ${reasonOf(error)}`)
      return
    }
    if (verbose) out(`'${srcName}' -> '${dstName}'\n`)
  }

  for (const source of sources) {
    const srcPath = resolve(cwd, source)
    const stripped = source.replace(/\/+$/, '') || source
    let dstPath = destPath
    let dstName = destination
    if (parents) {
      const rel = stripped.replace(/^\/+/, '')
      dstPath = join(destPath, rel)
      dstName = `${destination.replace(/\/+$/, '') || ''}/${rel}`
      // the leading directories are made as the source's own, with its modes
      const parts = rel.split('/').slice(0, -1)
      let made = ''
      let from = stripped.startsWith('/') ? '/' : cwd
      let ok = true
      for (const part of parts) {
        made = made ? `${made}/${part}` : part
        from = join(from, part)
        const target = join(destPath, made)
        if (tryStat(target)) continue
        try { mkdir(target, tryStat(from)?.mode & 0o777 || 0o755) } catch (error) { fail(`cannot make directory '${destination.replace(/\/+$/, '')}/${made}': ${reasonOf(error)}`); ok = false; break }
      }
      if (!ok) continue
    } else if (into) {
      dstPath = join(destPath, basename(stripped))
      dstName = `${destination.replace(/\/+$/, '') || '/'}/${basename(stripped)}`.replace(/^\/\//, '/')
    } else if (destination.endsWith('/') && !destIsDir) {
      fail(`cannot create regular file '${destination}': ${destStats ? 'Not a directory' : 'No such file or directory'}`)
      continue
    }
    await copy(srcPath, dstPath, source, dstName, true)
  }
  return failed ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
