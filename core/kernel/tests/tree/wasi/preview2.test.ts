import { beforeAll, describe, expect, it } from 'vitest'
import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A WASI Preview 2 component (p2-echo.wasm, see p2-echo.build.mjs) run from the shell: the kernel transpiles it with jco
 * and it runs as a worker process under /bin/wali on the real syscalls, its stdio the shell's redirections and pipes.
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
    expect(await kernel.wasm.canRunInWorker(bytes)).toBe(true)
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

  it('runs in a pipeline', async () => {
    const code = await kernel.shell.execute(`echo piped | ${program} > /tmp/p2.out 2> /dev/null`)
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/p2.out', 'utf-8')).toBe('piped\n')
  })

  it('is a real process: blocked reading a pipe, it shows in the table and dies to kill', async () => {
    const running = kernel.shell.execute(`sleep 30 | ${program} > /dev/null 2>&1`)
    let entry: { pid: number } | undefined
    for (let i = 0; i < 100 && !entry; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      entry = [...processes.values()].find(p => p.comm.endsWith('p2-echo.wasm') || p.argv?.[0]?.endsWith('p2-echo.wasm'))
    }
    expect(entry).toBeDefined()
    expect(await kernel.shell.execute(`kill -9 ${entry!.pid}`)).toBe(0)
    // the pipeline waits for `sleep` as well, so the component's own end is what is looked for
    for (let i = 0; i < 100 && processes.has(entry!.pid); i++) await new Promise(resolve => setTimeout(resolve, 50))
    expect(processes.has(entry!.pid)).toBe(false)
    await kernel.shell.execute('pkill sleep')
    await running
  }, 30_000)
})
