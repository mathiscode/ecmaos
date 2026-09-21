/**
 * Real `execve`'d `open` -- migrated off `Kernel`'s legacy in-process shim (`core/utils/src/commands/
 * open.ts`). Opening a browser tab or starting a download can only be done from the main thread, so
 * this parses its argument, checks the file exists, and asks the kernel to do the DOM part through
 * the `external`/`download` presenters (`#lib/presenters/open.ts`, via `window_present`).
 */

import { resolvePath } from './lib/paths.mjs'
import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, stat } = syscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: open [FILE|URL]
Open a file or URL.

  --help                   display this help and exit

Examples:
  open file.txt                    open a file in the current directory
  open /path/to/file.txt           open a file by absolute path
  open sample-1/sample-5 (1).jpg   open a file with spaces in the name
  open https://example.com         open a URL in a new tab`

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    err(usage)
    return 0
  }

  if (args.length === 0) {
    err('open: missing file or URL argument')
    err("Try 'open --help' for more information.")
    return 1
  }

  // Spaces in a name arrive as separate arguments unless quoted, so they are joined back (as the original did)
  const target = args.join(' ')

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(target)) {
    await present(syscalls, 'external', { url: target })
    return 0
  }

  const fullPath = resolvePath(getcwd(), target)

  try {
    stat(fullPath)
  } catch {
    err(`open: file not found: ${fullPath}`)
    return 1
  }

  try {
    await present(syscalls, 'download', { path: fullPath })
    return 0
  } catch (error) {
    err(`open: ${error instanceof Error ? error.message : 'Unknown error'}`)
    return 1
  }
}

try {
  exit(await main())
} catch (error) {
  err(`open: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
