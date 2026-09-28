/** Remove directories. Unlike real `rmdir`, this removes non-empty directories too, not just empty ones. */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, rmRecursive } = globalThis.ecmaosSyscalls

const usage = `Usage: rmdir [OPTION]... DIRECTORY...
Remove the DIRECTORY(ies), if they are empty.

  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length === 0) {
    writeAll(2, new TextEncoder().encode('rmdir: missing operand\n'))
    writeAll(2, new TextEncoder().encode("Try 'rmdir --help' for more information.\n"))
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
      writeAll(2, new TextEncoder().encode(`rmdir: ${target}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`rmdir: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
