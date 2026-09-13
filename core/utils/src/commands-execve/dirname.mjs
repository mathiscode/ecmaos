/**
 * Real `execve`'d `dirname` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/dirname.ts`) per `feat/1.0.0-execve-commands`.
 */

import { dirname } from './lib/path-utils.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const usage = `Usage: dirname [OPTION] NAME...
Output each NAME with its last non-slash component and trailing slashes removed.

  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const paths = args.filter(arg => arg !== '--help' && arg !== '-h' && !arg.startsWith('-'))
  if (paths.length === 0) {
    writeAll(2, new TextEncoder().encode('dirname: missing operand\n'))
    return 1
  }

  let output = ''
  for (const filePath of paths) output += dirname(filePath) + '\n'
  writeAll(1, new TextEncoder().encode(output))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`dirname: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
