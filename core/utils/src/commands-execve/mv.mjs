/**
 * Move or rename files and directories, as GNU `mv` does: an existing file is replaced (unless `-n`, or `-i` is
 * answered no), a directory destination receives the sources, and a file is never moved onto itself or a directory
 * into itself.
 */

import { resolve, join, basename } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { backupName, backupOptions, backupSettings, backupUsage } from './lib/backup.mjs'

const { argv, exit, writeAll, read, getcwd, stat, lstat, rename, rmdir, readdir } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`mv: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('mv') + '\n'))

const S_IFMT = 0xf000
const S_IFDIR = 0x4000

const usage = `Usage: mv [OPTION]... [-T] SOURCE DEST
  or:  mv [OPTION]... SOURCE... DIRECTORY
  or:  mv [OPTION]... -t DIRECTORY SOURCE...
Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.

${backupUsage}
  -f, --force                do not prompt before overwriting
  -i, --interactive          prompt before overwrite
  -n, --no-clobber           do not overwrite an existing file
  -t, --target-directory=DIRECTORY  move all SOURCE arguments into DIRECTORY
  -T, --no-target-directory  treat DEST as a normal file
  -u, --update               move only when the SOURCE file is newer than the destination file or the destination is missing
  -v, --verbose              explain what is being done
      --help                 display this help and exit`

const tryStat = (path, follow = true) => { try { return (follow ? stat : lstat)(path) } catch { return null } }
const isDir = stats => Boolean(stats) && (stats.mode & S_IFMT) === S_IFDIR
const same = (a, b) => a && b && String(a.dev) === String(b.dev) && a.ino === b.ino

function answer() {
  const byte = new Uint8Array(1)
  let line = ''
  for (;;) {
    if (read(0, byte, -1) <= 0 || byte[0] === 10) break
    line += String.fromCharCode(byte[0])
  }
  return /^y/i.test(line)
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'finuvTt:' + backupOptions.short,
    long: {
      force: 'f', interactive: 'i', 'no-clobber': 'n', update: 'u', verbose: 'v',
      'target-directory': { key: 't', arg: 'required' }, 'no-target-directory': 'T', help: 'help', ...backupOptions.long
    }
  })
  if (error) { err(error); hint(); return 1 }
  let interactive = false, noClobber = false, update = false, verbose = false, noTargetDir = false
  let targetDir
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 'f') { interactive = false; noClobber = false }
    else if (key === 'i') { interactive = true; noClobber = false }
    else if (key === 'n') { noClobber = true; interactive = false }
    else if (key === 'u') update = true
    else if (key === 'v') verbose = true
    else if (key === 'T') noTargetDir = true
    else if (key === 't') targetDir = value
  }
  const backup = backupSettings(options)
  if (backup.error) { err(backup.error); hint(); return 1 }
  if (targetDir !== undefined && noTargetDir) { err('cannot combine --target-directory (-t) and --no-target-directory (-T)'); return 1 }

  const cwd = getcwd()
  let sources = operands
  let destination
  if (targetDir !== undefined) {
    if (sources.length === 0) { err('missing file operand'); hint(); return 1 }
    destination = targetDir
    if (!isDir(tryStat(resolve(cwd, destination)))) { err(`target directory '${destination}': Not a directory`); return 1 }
  } else {
    if (sources.length === 0) { err('missing file operand'); hint(); return 1 }
    if (sources.length === 1) { err(`missing destination file operand after '${sources[0]}'`); hint(); return 1 }
    destination = sources[sources.length - 1]
    sources = sources.slice(0, -1)
  }
  const destPath = resolve(cwd, destination)
  const destIsDir = isDir(tryStat(destPath))
  if (noTargetDir && sources.length > 1) { err(`extra operand '${sources[1]}'`); hint(); return 1 }
  if (!noTargetDir && targetDir === undefined && sources.length > 1 && !destIsDir) { err(`target '${destination}' is not a directory`); return 1 }
  const into = !noTargetDir && destIsDir

  let failed = false
  const fail = text => { err(text); failed = true }

  for (const source of sources) {
    const srcPath = resolve(cwd, source)
    const stripped = source.replace(/\/+$/, '') || source
    const dstPath = into ? join(destPath, basename(stripped)) : destPath
    const dstName = into ? `${destination.replace(/\/+$/, '') || ''}/${basename(stripped)}` : destination

    let srcStats
    try { srcStats = lstat(srcPath) } catch (error) { fail(`cannot stat '${source}': ${reasonOf(error)}`); continue }
    const dstStats = tryStat(dstPath, false)
    const srcIsDir = isDir(srcStats)

    if (srcIsDir && (dstPath === srcPath || dstPath.startsWith(srcPath + '/'))) {
      fail(`cannot move '${source}' to a subdirectory of itself, '${dstName}'`)
      continue
    }
    if (dstStats && same(srcStats, tryStat(dstPath, false)) && !(dstStats.nlink > 1 && dstPath !== srcPath)) {
      fail(`'${source}' and '${dstName}' are the same file`)
      continue
    }
    if (dstStats) {
      const dstIsDir = isDir(tryStat(dstPath))
      if (srcIsDir && !dstIsDir) { fail(`cannot overwrite non-directory '${dstName}' with directory '${source}'`); continue }
      if (!srcIsDir && dstIsDir) { fail(`cannot overwrite directory '${dstName}' with non-directory`); continue }
      if (noClobber) continue
      if (update && dstStats.mtimeMs >= srcStats.mtimeMs) continue
      if (interactive) {
        writeAll(2, encoder.encode(`mv: overwrite '${dstName}'? `))
        if (!answer()) { fail(`not replacing '${dstName}'`); continue }
      }
    }
    try {
      if (dstStats && backup.control !== 'none' && !isDir(tryStat(dstPath))) {
        const saved = backupName(dstPath, backup, readdir)
        if (saved) rename(dstPath, saved)
      }
      // The kernel's rename(2) says "Is a directory" for a directory onto a directory, and cannot replace an empty one
      if (srcIsDir && dstStats && isDir(tryStat(dstPath))) {
        if (readdir(dstPath).length > 0) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' })
        rmdir(dstPath)
      }
      rename(srcPath, dstPath)
    } catch (error) {
      fail(`cannot move '${source}' to '${dstName}': ${reasonOf(error)}`)
      continue
    }
    if (verbose) out(`renamed '${source}' -> '${dstName}'\n`)
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
