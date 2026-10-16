/**
 * Make links between files, as GNU `ln` does. A symbolic link stores the TARGET text as given (a dangling or relative
 * one is fine; `-r` computes a relative one); a hard link needs an existing non-directory. With several TARGETs, or
 * `-t DIR`, the last operand is a directory the links are made in; `-T` never treats it as one; `-f` replaces an
 * existing destination; `-n` treats a symlink to a directory as a plain file.
 */

import { resolve, join, basename, dirname, relative } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { backupName, backupOptions, backupSettings, backupUsage } from './lib/backup.mjs'

const { argv, exit, writeAll, getcwd, stat, lstat, link, symlink, unlink, rename, readdir } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`ln: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('ln') + '\n'))

const S_IFMT = 0xf000
const S_IFDIR = 0x4000

const usage = `Usage: ln [OPTION]... TARGET LINK_NAME
  or:  ln [OPTION]... TARGET
  or:  ln [OPTION]... TARGET... DIRECTORY
  or:  ln [OPTION]... -t DIRECTORY TARGET...
Create a link to TARGET with the name LINK_NAME.

${backupUsage}
  -f, --force                 remove existing destination files
  -n, --no-dereference        treat LINK_NAME as a normal file if it is a symbolic link to a directory
  -r, --relative              with -s, create links relative to link location
  -s, --symbolic              make symbolic links instead of hard links
  -t, --target-directory=DIRECTORY  specify the DIRECTORY in which to create the links
  -T, --no-target-directory   treat LINK_NAME as a normal file always
  -v, --verbose               print name of each linked file
      --help                  display this help and exit`

const tryStat = (path, follow) => { try { return (follow ? stat : lstat)(path) } catch { return null } }
const isDir = stats => stats && (stats.mode & S_IFMT) === S_IFDIR

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'sfnrvt:TiPL' + backupOptions.short,
    long: {
      symbolic: 's', force: 'f', 'no-dereference': 'n', relative: 'r', verbose: 'v', 'target-directory': { key: 't', arg: 'required' },
      'no-target-directory': 'T', interactive: 'i', logical: 'L', physical: 'P', help: 'help', ...backupOptions.long
    }
  })
  if (error) { err(error); hint(); return 1 }
  let symbolic = false, force = false, noDereference = false, relativeLinks = false, verbose = false, noTargetDir = false
  let targetDir
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 's') symbolic = true
    else if (key === 'f') force = true
    else if (key === 'n') noDereference = true
    else if (key === 'r') relativeLinks = true
    else if (key === 'v') verbose = true
    else if (key === 'T') noTargetDir = true
    else if (key === 't') targetDir = value
  }
  const backup = backupSettings(options)
  if (backup.error) { err(backup.error); hint(); return 1 }
  if (targetDir !== undefined && noTargetDir) { err('cannot combine --target-directory and --no-target-directory'); return 1 }

  const cwd = getcwd()
  let targets = operands
  let destination

  if (targetDir !== undefined) {
    if (targets.length === 0) { err('missing file operand'); hint(); return 1 }
    if (!isDir(tryStat(resolve(cwd, targetDir), true))) { err(`target '${targetDir}' is not a directory`); return 1 }
    destination = targetDir
  } else if (targets.length === 0) {
    err('missing file operand')
    hint()
    return 1
  } else if (targets.length === 1) {
    if (noTargetDir) { err(`missing destination file operand after '${targets[0]}'`); hint(); return 1 }
    destination = '.'
  } else {
    destination = targets[targets.length - 1]
    targets = targets.slice(0, -1)
    const stats = tryStat(resolve(cwd, destination), !noDereference)
    if (noTargetDir) {
      if (targets.length > 1) { err(`extra operand '${targets[1]}'`); hint(); return 1 }
      destination = null
    } else if (!isDir(stats)) {
      if (targets.length > 1) { err(`target '${destination}' is not a directory`); return 1 }
      // One target and a destination that is not a directory: the destination is the link's name
      destination = null
      targets = [targets[0]]
    }
  }

  let failed = false
  const lastOperand = operands[operands.length - 1]
  for (const target of targets) {
    let name
    if (destination === null) name = lastOperand
    else name = destination === '.' ? basename(target) : `${destination.replace(/\/+$/, '') || '/'}/${basename(target)}`
    const linkPath = resolve(cwd, name)

    let content = target
    if (symbolic && relativeLinks) content = relative(dirname(linkPath), resolve(cwd, target)) || '.'
    if (!symbolic) {
      const stats = tryStat(resolve(cwd, target), false)
      if (!stats) { err(`failed to access '${target}': No such file or directory`); failed = true; continue }
      if (isDir(stats)) { err(`'${target}': hard link not allowed for directory`); failed = true; continue }
    }

    const existing = tryStat(linkPath, false)
    if (existing && (force || backup.control !== 'none')) {
      if (!symbolic && backup.control === 'none') {
        const source = tryStat(resolve(cwd, target), true)
        const dest = tryStat(linkPath, true)
        if (source && dest && source.ino === dest.ino && source.dev === dest.dev) {
          err(`'${target}' and '${name}' are the same file`)
          failed = true
          continue
        }
      }
      try {
        const saved = backupName(linkPath, backup, readdir)
        if (saved) rename(linkPath, saved)
        else unlink(linkPath)
      } catch (error) {
        err(`cannot remove '${name}': ${reasonOf(error)}`)
        failed = true
        continue
      }
    }
    try {
      // The kernel's link(2) and symlink(2) replace an existing name instead of failing with EEXIST, so ask first
      if (!force && backup.control === 'none' && tryStat(linkPath, false)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      if (symbolic) symlink(content, linkPath)
      else link(resolve(cwd, target), linkPath)
    } catch (error) {
      err(symbolic ? `failed to create symbolic link '${name}': ${reasonOf(error)}` : `failed to create hard link '${name}' => '${target}': ${reasonOf(error)}`)
      failed = true
      continue
    }
    if (verbose) out(symbolic ? `'${name}' -> '${content}'\n` : `'${name}' => '${target}'\n`)
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
