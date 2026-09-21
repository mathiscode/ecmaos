/**
 * Real `execve`'d `less` -- migrated off `Kernel.executeCommand`'s legacy shim
 * (`core/utils/src/commands/less.ts`). The original reached into `terminal.onKey`/`unlisten`; this
 * one is an ordinary program that puts its terminal in raw mode (`lib/tty.mjs`) and `read()`s single
 * keypresses from it, which works because `Kernel.executeViaExecve` routes the keyboard through the
 * real `@zenfs/linux` line discipline while a foreground process runs.
 */

import { resolve } from './lib/path-utils.mjs'
import { readFdText, readTextFile } from './lib/fs-text.mjs'
import { page } from './lib/pager.mjs'
import { isTty, pagerTty } from './lib/tty.mjs'

const { argv, exit, writeAll, getcwd, stat, isDirectory } = globalThis.ecmaosSyscalls

const usage = `Usage: less [OPTION]... FILE
View file contents interactively.

  FILE    the file to view (if omitted, reads from stdin)
  --help  display this help and exit`

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

function main() {
  const args = argv.slice(1)
  if (args[0] === '--help' || args[0] === '-h') {
    err(usage)
    return 0
  }

  const filePath = args[0] !== undefined && !args[0].startsWith('-') ? args[0] : undefined
  let content

  if (filePath) {
    const fullPath = resolve(getcwd(), filePath)
    try {
      stat(fullPath)
    } catch {
      err(`less: ${filePath}: No such file or directory`)
      return 1
    }
    if (isDirectory(fullPath)) {
      err(`less: ${filePath}: Is a directory`)
      return 1
    }
    content = readTextFile(fullPath)
  } else {
    if (isTty(0)) {
      err('less: Missing filename ("less --help" for help)')
      return 1
    }
    content = readFdText(0)
  }

  const lines = content.split('\n')
  const tty = pagerTty()

  // No terminal to page on (`less f > out`, or a test harness): behave like `cat`, as real less does.
  if (tty === -1) {
    writeAll(1, encoder.encode(content))
    return 0
  }

  // `cat f | less`: stdin is the data pipe, so keys must come from the terminal fd, not fd 0.
  page(lines, tty)
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`less: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
