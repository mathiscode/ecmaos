/**
 * Real `execve`'d `mv` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/mv.ts`) per `feat/1.0.0-execve-commands`.
 */

import { resolve, join, basename } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, stat, isDirectory, rename } = globalThis.ecmaosSyscalls

const usage = `Usage: mv [OPTION]... SOURCE... DEST
Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.

  --help  display this help and exit`

function exists(path) {
  try { stat(path); return true } catch { return false }
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const paths = args.filter(arg => arg && !arg.startsWith('-'))
  if (paths.length < 2) {
    writeAll(2, new TextEncoder().encode('Usage: mv <source> <destination>\n'))
    return 1
  }

  const cwd = getcwd()
  const source = resolve(cwd, paths[0])
  let destination = resolve(cwd, paths[paths.length - 1])

  if (source === destination) return 0

  const disallowed = ['/dev', '/proc', '/sys', '/run']
  if (disallowed.some(p => source.startsWith(p) || destination.startsWith(p))) {
    writeAll(2, new TextEncoder().encode('Cannot move disallowed paths\n'))
    return 2
  }

  if (exists(destination)) {
    if (isDirectory(destination)) {
      destination = join(destination, basename(source))
    } else {
      writeAll(2, new TextEncoder().encode(`${destination} already exists\n`))
      return 1
    }
  }

  rename(source, destination)
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`mv: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
