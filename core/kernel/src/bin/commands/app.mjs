/**
 * `/bin/app`: runs an `@ecmaos-apps/*` program as a real worker process. `Kernel.execute` launches it
 * as `app <file> [args...]`. A `#!ecmaos:bin:program:<name>` app runs in this worker: its bundle is
 * imported, its `ProcessEntryParams` are built over real syscalls (`lib/app-params.mjs`) and its `main`
 * is called. A `#!ecmaos:bin:app:<name>` app needs the DOM, so its `main` runs on the main thread
 * through the `app` presenter. Either way the app's return value is the process's exit code.
 */

import { createAppParams } from './lib/app-params.mjs'
import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, env, exit, write, open, read, close } = syscalls

const fail = (message, code = 1) => {
  write(2, new TextEncoder().encode(`app: ${message}\n`))
  exit(code)
}

async function readSource(path) {
  const fd = open(path, 0, 0)
  const chunks = []
  try {
    while (true) {
      const buffer = new Uint8Array(65536)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
    }
  } finally {
    close(fd)
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

const file = argv[1]
if (!file) fail('usage: app <program> [args...]', 2)

try {
  const source = await readSource(file)
  const header = new TextDecoder().decode(source.subarray(0, 200)).split('\n')[0] ?? ''
  const name = header.startsWith('#!ecmaos:bin:program:') ? header.slice('#!ecmaos:bin:program:'.length).trim() : file.split('/').pop()

  // `#!ecmaos:bin:app:<name>`: a DOM app. This process is its real identity (pid, signals, exit code);
  // its `main` runs on the main thread, where `document` is, through the `app` presenter.
  if (header.startsWith('#!ecmaos:bin:app:')) {
    const appName = header.slice('#!ecmaos:bin:app:'.length).trim()
    const { result } = await present(syscalls, 'app', { file, args: argv.slice(2), command: appName })
    exit(typeof result === 'number' ? result : 0)
  }

  const module = await import(`data:text/javascript;base64,${btoa(Array.from(source, byte => String.fromCharCode(byte)).join(''))}`)
  const main = module.main ?? module.default
  if (typeof main !== 'function') fail('no main function found in module')

  const app = createAppParams({ syscalls, init: { argv, env }, command: name })
  await app.load()
  const result = await main(app.params)
  exit(typeof result === 'number' ? result : 0)
} catch (error) {
  write(2, new TextEncoder().encode(`${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
