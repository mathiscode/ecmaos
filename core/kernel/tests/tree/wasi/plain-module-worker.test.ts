import { beforeAll, describe, expect, it } from 'vitest'
import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A core module with no WASI or WALI imports at all runs as a worker process under `/bin/wali` like any other, with
 * no host calls bound; one that is a library (no `_start`, `_initialize` or `main`) is refused with a message.
 */
async function compile(wat: string): Promise<Uint8Array> {
  const wabt = await (await import('wabt')).default()
  const parsed = wabt.parseWat('fixture.wat', wat)
  const { buffer } = parsed.toBinary({})
  parsed.destroy()
  return buffer
}

// No imports at all - not a WASI module, so `_start` runs on the module's own linear memory with
// no host calls; `_start` simply returns without doing anything observable from outside.
const PLAIN = `(module (memory (export "memory") 1) (func (export "_start")))`
// no memory either
const PLAIN_NO_MEMORY = `(module (func (export "_start")))`
const LIBRARY = `(module (memory (export "memory") 1) (func (export "add") (param i32 i32) (result i32) (i32.add (local.get 0) (local.get 1))))`
// an import nothing provides, called by `_start`
const CALLS_MISSING = `(module (import "env" "log" (func $log)) (func (export "_start") (call $log)))`

describe('a core module with no WASI imports', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  const install = async (name: string, wat: string) => {
    const bytes = await compile(wat)
    await kernel.filesystem.fs.writeFile(`/tmp/${name}.wasm`, bytes, { mode: 0o755 })
    return { bytes, path: `/tmp/${name}.wasm` }
  }

  it('is routed to the worker', async () => {
    for (const wat of [PLAIN, PLAIN_NO_MEMORY, LIBRARY, CALLS_MISSING]) expect(await kernel.wasm.canRunInWorker(await compile(wat))).toBe(true)
  })

  it('runs for real, as a process with a real pid that is gone afterwards', async () => {
    const { path } = await install('plain', PLAIN)
    expect(await kernel.shell.execute(path)).toBe(0)
    const code = await kernel.shell.execute(path)
    expect(code).toBe(0)
    expect([...processes.values()].filter(p => p.argv[0] === path)).toEqual([])
  })

  it('runs without a memory', async () => {
    const { path } = await install('plain-nomem', PLAIN_NO_MEMORY)
    expect(await kernel.shell.execute(path)).toBe(0)
  })

  const run = async (path: string) => {
    const code = await kernel.shell.execute(`${path} > /tmp/pm.out 2> /tmp/pm.err`)
    return { code, stderr: await kernel.filesystem.fs.readFile('/tmp/pm.err', 'utf-8') }
  }

  it('refuses a library, saying why', async () => {
    const { path } = await install('library', LIBRARY)
    const { code, stderr } = await run(path)
    expect(code).toBe(1)
    expect(stderr).toBe(`${path}: not a program: the module exports none of _start, _initialize or main (a library)\n`)
  })

  it('stops a program that calls an import nothing provides, naming it', async () => {
    const { path } = await install('missing', CALLS_MISSING)
    const { code, stderr } = await run(path)
    expect(code).toBe(1)
    expect(stderr).toBe(`${path}: module imports env.log, which ecmaOS does not provide\n`)
  })
})
