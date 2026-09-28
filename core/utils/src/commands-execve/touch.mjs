/**
 * Create a file if it doesn't exist. Unlike a real `touch`, this does not update the modification
 * time of a file that already exists.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, open, close, O_WRONLY, O_CREAT } = globalThis.ecmaosSyscalls

const usage = `Usage: touch [OPTION]... FILE...
Update the access and modification times of each FILE to the current time.

  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }
  if (args.length === 0) {
    writeAll(2, new TextEncoder().encode("touch: missing file operand\nTry 'touch --help' for more information.\n"))
    return 1
  }

  const cwd = getcwd()
  let hasError = false

  for (const target of args) {
    if (!target || target.startsWith('-')) continue
    const fullPath = resolve(cwd, target)
    try {
      close(open(fullPath, O_WRONLY | O_CREAT, 0o644))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeAll(2, new TextEncoder().encode(`touch: ${target}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`touch: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
