/**
 * Real `execve`'d `download`: hands files to the browser as downloads. The program checks that each
 * path exists and asks for the `download` presenter (`#lib/presenters/open.ts`, the same one `open`
 * uses), which builds the blob and clicks the anchor on the main thread.
 */
import { join } from './lib/path-utils.mjs'
import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, stat, getcwd } = syscalls

const usage = `Usage: download FILE...
Download files from the filesystem through the browser.

  --help  display this help and exit`

const encoder = new TextEncoder()
const stderr = text => write(2, encoder.encode(text + '\n'))

async function main() {
  const args = argv.slice(1)
  if (args[0] === '--help' || args[0] === '-h') {
    stderr(usage)
    return 0
  }
  if (args.length === 0) {
    stderr('download: missing file operand')
    stderr("Try 'download --help' for more information.")
    return 1
  }

  let code = 0
  for (const arg of args) {
    const full = arg.startsWith('/') ? arg : join(getcwd(), arg)
    try {
      stat(full)
    } catch {
      stderr(`\x1b[31m${full} not found\x1b[0m`)
      code = 1
      continue
    }
    try {
      await present(syscalls, 'download', { path: full })
    } catch (error) {
      stderr(`download: ${error instanceof Error ? error.message : String(error)}`)
      code = 1
    }
  }
  return code
}

try {
  exit(await main())
} catch (error) {
  write(2, encoder.encode(`download: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
