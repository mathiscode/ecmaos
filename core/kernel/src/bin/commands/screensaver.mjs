/**
 * Real `execve`'d `screensaver`: starts a screensaver on the terminal. The screensaver draws over
 * the page, so the `screensaver_run` syscall (`#lib/main-thread-syscalls.ts`) does the work
 * main-thread side; this program parses arguments and prints what comes back.
 */
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const { argv, exit, write, custom, open, read, close, unlink } = globalThis.ecmaosSyscalls

const usage = `Usage: screensaver [NAME] [--set]
Start a screensaver (default: the saved one, else matrix). NAME 'off' clears the saved default.

  --set   save NAME as the default screensaver
  --help  display this help and exit`

const encoder = new TextEncoder()

async function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) {
    write(2, encoder.encode(usage + '\n'))
    return 0
  }

  const set = args.includes('--set')
  const name = args.find(arg => !arg.startsWith('--'))

  const path = scratchPath('screensaver')
  await custom('screensaver_run', name ?? '', set ? 1 : 0, path)
  const { code, lines } = JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
  for (const { stream, text } of lines) write(stream === 'err' ? 2 : 1, encoder.encode(text + '\n'))
  return code
}

try {
  exit(await main())
} catch (error) {
  write(2, encoder.encode(`screensaver: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
