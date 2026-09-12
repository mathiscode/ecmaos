/**
 * Real `execve`'d `rmdir` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/rmdir.ts`) per `feat/1.0.0-execve-commands`. The original always did a
 * recursive `rm` rather than real `rmdir`'s empty-directory-only semantics -- carried over unchanged
 * (this is a migration, not a correctness fix).
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, getcwd, rmRecursive } = globalThis.ecmaosSyscalls

const usage = `Usage: rmdir [OPTION]... DIRECTORY...
Remove the DIRECTORY(ies), if they are empty.

  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length === 0) {
    write(2, new TextEncoder().encode('rmdir: missing operand\n'))
    write(2, new TextEncoder().encode("Try 'rmdir --help' for more information.\n"))
    return 1
  }

  const cwd = getcwd()
  let hasError = false

  for (const target of args) {
    if (!target || target.startsWith('-')) continue
    const fullPath = resolve(cwd, target)
    try {
      rmRecursive(fullPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      write(2, new TextEncoder().encode(`rmdir: ${target}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`rmdir: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
