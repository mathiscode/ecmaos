/**
 * `/bin/app`: runs an `@ecmaos-apps/*` program (`#!ecmaos:bin:program:<name>`) as a real worker
 * process. `Kernel.execute` launches it as `app <file> [args...]`; this imports the app's bundle,
 * builds its `ProcessEntryParams` over real syscalls (`lib/app-params.mjs`) and calls its `main`.
 * The app's return value is its exit code.
 */

import { createAppParams } from './lib/app-params.mjs'

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
