/** Load and run a JavaScript file in the page's own global scope (reaching `document`/`window`/`ecmaos`). */
import { join } from './lib/path-utils.mjs'
import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, getcwd } = syscalls

const usage = `Usage: load FILE
Load a JavaScript file and run it in the page.

  --help  display this help and exit`

const encoder = new TextEncoder()
const stderr = text => write(2, encoder.encode(text + '\n'))

async function main() {
  const [target] = argv.slice(1)
  if (target === '--help' || target === '-h') {
    stderr(usage)
    return 0
  }
  if (!target) {
    stderr(usage)
    return 1
  }

  try {
    await present(syscalls, 'script', { path: target.startsWith('/') ? target : join(getcwd(), target) })
    return 0
  } catch (error) {
    stderr(`load: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

try {
  exit(await main())
} catch (error) {
  write(2, encoder.encode(`load: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
