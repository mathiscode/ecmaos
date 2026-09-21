/**
 * Real `execve`'d `upload`: opens the browser's file picker and writes the chosen files into a
 * directory. The picker is DOM, so the `upload` presenter (`#lib/presenters/upload.ts`) runs it
 * main-thread side and reports back once the dialog is closed; this program parses arguments and
 * prints what happened.
 */
import { join } from './lib/path-utils.mjs'
import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, getcwd } = syscalls

const usage = `Usage: upload [DIRECTORY]
Upload files from your computer into DIRECTORY (default: the current directory).

  --help  display this help and exit`

const encoder = new TextEncoder()
const stderr = text => write(2, encoder.encode(text + '\n'))

async function main() {
  const [destination] = argv.slice(1)
  if (destination === '--help' || destination === '-h') {
    stderr(usage)
    return 0
  }

  const cwd = getcwd()
  const directory = destination ? (destination.startsWith('/') ? destination : join(cwd, destination)) : cwd

  const { result } = await present(syscalls, 'upload', { directory })
  const { uploaded = [], errors = [] } = result ?? {}
  for (const name of uploaded) write(1, encoder.encode(`${name}\n`))
  for (const message of errors) stderr(`\x1b[31m${message}\x1b[0m`)
  return errors.length > 0 ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  write(2, encoder.encode(`upload: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
