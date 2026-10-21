import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A WASI Preview 2 component (p2-echo.wasm, see p2-echo.build.mjs) run from the shell: jco transpiles it and it runs
 * on the main thread on preview2-shim, its stdio joined to the shell's redirections.
 */
describe('a WASI Preview 2 component', () => {
  let kernel: Kernel
  const program = '/tmp/p2-echo.wasm'

  const run = async (line: string) => {
    const code = await kernel.shell.execute(`${line} > /tmp/p2.out 2> /tmp/p2.err`)
    return {
      code,
      stdout: await kernel.filesystem.fs.readFile('/tmp/p2.out', 'utf-8'),
      stderr: await kernel.filesystem.fs.readFile('/tmp/p2.err', 'utf-8')
    }
  }

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const { readFileSync } = process.getBuiltinModule('node:fs')
    await kernel.filesystem.fs.writeFile(program, new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/p2-echo.wasm`)), { mode: 0o755 })
  })

  it('is recognized as a component', async () => {
    const bytes = await kernel.filesystem.fs.readFile(program)
    expect(await kernel.wasm.detectWasiVersion(bytes)).toBe('preview2')
    expect(await kernel.wasm.canRunInWorker(bytes)).toBe(false)
  })

  it('gets its arguments and writes to stdout and stderr', async () => {
    const { stdout, stderr } = await run(`${program} one two < /dev/null`)
    expect(stdout).toBe('one\ntwo\n')
    expect(stderr).toBe('p2-echo: done\n')
  })

  it('reads stdin', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/p2.in', 'from a file\n')
    const { code, stdout } = await run(`${program} < /tmp/p2.in`)
    expect(code).toBe(0)
    expect(stdout).toBe('from a file\n')
  })

  // wasi:cli/exit in WASI 0.2 takes only ok or err, so the preview1 adapter turns any nonzero status into 1
  it('exits 1 for a failure and 0 for success', async () => {
    expect((await run(`${program} a b c < /dev/null`)).code).toBe(1)
    expect((await run(`${program} < /dev/null`)).code).toBe(0)
  })

  // Node 22 (CI) and Firefox have no JSPI: stdin is read to its end first, and the program runs without suspending
  it('runs where WebAssembly has no JSPI', async () => {
    const wasm = WebAssembly as { Suspending?: unknown }
    const suspending = wasm.Suspending
    wasm.Suspending = undefined
    try {
      await kernel.filesystem.fs.writeFile('/tmp/p2.in', 'without jspi\n')
      const { code, stdout, stderr } = await run(`${program} arg < /tmp/p2.in`)
      expect(stdout).toBe('arg\nwithout jspi\n')
      expect(stderr).toBe('p2-echo: done\n')
      expect(code).toBe(1)
    } finally {
      wasm.Suspending = suspending
    }
  })

  it('runs in a pipeline', async () => {
    const code = await kernel.shell.execute(`echo piped | ${program} > /tmp/p2.out 2> /dev/null`)
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/p2.out', 'utf-8')).toBe('piped\n')
  })
})
