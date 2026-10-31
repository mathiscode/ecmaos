import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A component the shell did not start: dash execs it, so its worker is not sent a transpiled component by
 * `Kernel.execute`. The worker's start waits while the kernel prepares one (`setProgramPreparer`).
 */
describe('a WASI Preview 2 component started by another program', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
    const { readFileSync } = process.getBuiltinModule('node:fs')
    await kernel.filesystem.fs.writeFile('/tmp/p2-echo.wasm', new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/p2-echo.wasm`)), { mode: 0o755 })
  })

  it('runs, with its arguments, stdin and stdout', async () => {
    const code = await kernel.shell.execute('dash -c "echo piped | /tmp/p2-echo.wasm viaexec" > /tmp/p2x.out 2> /tmp/p2x.err')
    expect(await kernel.filesystem.fs.readFile('/tmp/p2x.out', 'utf-8')).toBe('viaexec\npiped\n')
    expect(await kernel.filesystem.fs.readFile('/tmp/p2x.err', 'utf-8')).toBe('p2-echo: done\n')
    expect(code).toBe(1)
  }, 60_000)
})
