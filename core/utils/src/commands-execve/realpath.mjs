/**
 * Real `execve`'d `realpath` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/realpath.ts`) per `feat/1.0.0-execve-commands`. The original never
 * actually followed symlinks either (just `path.resolve` plus an optional existence check for
 * `-e`) -- carried over unchanged, this is a migration, not a correctness fix.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, getcwd, access } = globalThis.ecmaosSyscalls

const usage = `Usage: realpath [OPTION]... FILE...
Print the resolved absolute file name.

  -e, --canonicalize-existing  all components of the path must exist
  -q, --quiet                  suppress most error messages
  --help                       display this help and exit`

function exists(path) {
  try { access(path); return true } catch { return false }
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let canonicalizeExisting = false
  let quiet = false
  const files = []

  for (const arg of args) {
    if (arg === '-e' || arg === '--canonicalize-existing') canonicalizeExisting = true
    else if (arg === '-q' || arg === '--quiet') quiet = true
    else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('e')) canonicalizeExisting = true
      if (flags.includes('q')) quiet = true
      const invalid = flags.find(f => !['e', 'q'].includes(f))
      if (invalid) {
        write(2, new TextEncoder().encode(`realpath: invalid option -- '${invalid}'\n`))
        write(2, new TextEncoder().encode("Try 'realpath --help' for more information.\n"))
        return 1
      }
    } else {
      files.push(arg)
    }
  }

  if (files.length === 0) {
    write(2, new TextEncoder().encode('realpath: missing operand\n'))
    write(2, new TextEncoder().encode("Try 'realpath --help' for more information.\n"))
    return 1
  }

  const cwd = getcwd()
  let hasError = false
  let output = ''

  for (const file of files) {
    const fullPath = resolve(cwd, file)
    const resolved = resolve(cwd, fullPath)

    if (canonicalizeExisting && !exists(resolved)) {
      if (!quiet) write(2, new TextEncoder().encode(`realpath: ${file}: No such file or directory\n`))
      hasError = true
      continue
    }

    output += resolved + '\n'
  }
  write(1, new TextEncoder().encode(output))

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`realpath: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
