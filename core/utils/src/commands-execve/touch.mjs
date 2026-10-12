/** Create a file if it doesn't exist; otherwise set its access and modification times to now (a directory's too). */

import { resolve } from './lib/path-utils.mjs'
import { utimesOwned } from './lib/owner-ops.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, open, close, stat, O_WRONLY, O_CREAT } = sys

const usage = `Usage: touch [OPTION]... FILE...
Update the access and modification times of each FILE to the current time.

  --help  display this help and exit`

async function main() {
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
      let exists = true
      try { stat(fullPath) } catch { exists = false }
      if (exists) await utimesOwned(sys, fullPath, -1, -1)
      else close(open(fullPath, O_WRONLY | O_CREAT, 0o644))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeAll(2, new TextEncoder().encode(`touch: ${target}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`touch: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
