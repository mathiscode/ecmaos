import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * With OpenTelemetry on, its context manager loads zone.js, which replaces the global Promise; jco's generated code
 * only waits on what is `instanceof Promise`, and a component failed to instantiate. A file of its own, since zone.js
 * patches the globals for the rest of the file. jco's own bindgen has the same runner, patched by the build's
 * jco-browser-fix plugin; the tests load it natively, unpatched, so it starts before zone.js does (the browser test with
 * OpenTelemetry on covers the patched one).
 */
describe('a WASI Preview 2 component under zone.js', () => {
  let kernel: Kernel

  beforeAll(async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/p2-echo.wasm`))
    // a first generate waits for jco to start
    const { generate } = await import('@bytecodealliance/jco/component')
    await generate(bytes, { name: 'warm', noTypescript: true })
    await import('@opentelemetry/context-zone')
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    await kernel.filesystem.fs.writeFile('/tmp/p2-echo.wasm', bytes, { mode: 0o755 })
  })

  it('runs', async () => {
    expect(globalThis.Promise.name).toBe('ZoneAwarePromise')
    await kernel.filesystem.fs.writeFile('/tmp/p2.in', 'zoned\n')
    expect(await kernel.shell.execute('/tmp/p2-echo.wasm < /tmp/p2.in > /tmp/p2.out 2> /dev/null')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/p2.out', 'utf-8')).toBe('zoned\n')
  })
})
