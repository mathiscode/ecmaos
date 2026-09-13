/**
 * Real `execve`'d `ln` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/ln.ts`) per `feat/1.0.0-execve-commands`. Needed real `link`/`symlink`
 * syscalls this interpreter didn't expose yet -- added to `globalThis.ecmaosSyscalls` in
 * `/bin/node.mjs` alongside `readlink` (for the `readlink`/`realpath` migrations).
 */

import { resolve, basename, join } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, stat, isDirectory, unlink, rmdir, symlink, link } = globalThis.ecmaosSyscalls

const usage = `Usage: ln [OPTION]... [-T] TARGET LINK_NAME
   or:  ln [OPTION]... TARGET
   or:  ln [OPTION]... TARGET... DIRECTORY
Create links between files.

  -s, --symbolic  make symbolic links instead of hard links
  -f, --force     remove existing destination files
  -v, --verbose   print name of each linked file
  --help          display this help and exit`

function exists(path) {
  try { return stat(path) } catch { return null }
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const positional = []
  let symbolic = false
  let force = false
  let verbose = false

  for (const arg of args) {
    if (arg === '-s' || arg === '--symbolic') symbolic = true
    else if (arg === '-f' || arg === '--force') force = true
    else if (arg === '-v' || arg === '--verbose') verbose = true
    else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('s')) symbolic = true
      if (flags.includes('f')) force = true
      if (flags.includes('v')) verbose = true
      const invalid = flags.find(f => !['s', 'f', 'v'].includes(f))
      if (invalid) { writeAll(2, new TextEncoder().encode(`ln: invalid option -- '${invalid}'\n`)); return 1 }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) {
    writeAll(2, new TextEncoder().encode('ln: missing file operand\n'))
    writeAll(2, new TextEncoder().encode("Try 'ln --help' for more information.\n"))
    return 1
  }

  const cwd = getcwd()
  const target = positional[0]
  const targetPath = resolve(cwd, target)

  const targetStats = exists(targetPath)
  if (!targetStats) {
    writeAll(2, new TextEncoder().encode(`ln: ${target}: No such file or directory\n`))
    return 1
  }
  const targetIsDir = isDirectory(targetPath)
  if (!symbolic && targetIsDir) {
    writeAll(2, new TextEncoder().encode(`ln: ${target}: hard link not allowed for directory\n`))
    return 1
  }

  let linkName
  if (positional.length === 1) {
    linkName = join(cwd, basename(target))
  } else {
    const linkNameInput = positional[1]
    const linkNamePath = resolve(cwd, linkNameInput)
    const linkNameStats = exists(linkNamePath)
    linkName = (linkNameStats && isDirectory(linkNamePath)) ? join(linkNamePath, basename(target)) : linkNamePath
  }

  try {
    const linkExists = exists(linkName)
    if (linkExists) {
      if (force) {
        if (isDirectory(linkName)) rmdir(linkName)
        else unlink(linkName)
      } else {
        writeAll(2, new TextEncoder().encode(`ln: ${linkName}: File exists\n`))
        return 1
      }
    }

    if (symbolic) symlink(targetPath, linkName)
    else link(targetPath, linkName)

    if (verbose) writeAll(1, new TextEncoder().encode(linkName + '\n'))

    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`ln: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`ln: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
