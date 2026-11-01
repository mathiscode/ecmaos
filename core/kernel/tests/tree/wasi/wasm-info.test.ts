import { beforeAll, describe, expect, it } from 'vitest'
import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `wasm info FILE` has `/bin/wali` describe a module with the tables its hosts hand a program, so what it calls not
 * provided is what a run would stop at.
 */
async function compile(wat: string): Promise<Uint8Array> {
  const wabt = await (await import('wabt')).default()
  const parsed = wabt.parseWat('fixture.wat', wat)
  const { buffer } = parsed.toBinary({})
  parsed.destroy()
  return buffer
}

const fixture = (name: string) => {
  const { readFileSync } = process.getBuiltinModule('node:fs')
  const { join } = process.getBuiltinModule('node:path')
  return new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))
}

const PLAIN = `(module (memory (export "memory") 1) (func (export "_start")))`
const LIBRARY = `(module (memory (export "memory") 1) (func (export "add") (param i32 i32) (result i32) (i32.add (local.get 0) (local.get 1))))`
const MISSING = `(module
  (import "wasi_snapshot_preview1" "proc_exit" (func (param i32)))
  (import "wasi_snapshot_preview1" "sock_shutdown" (func (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "no_such_call" (func))
  (import "env" "log" (func))
  (memory (export "memory") 1) (func (export "_start")))`

describe('wasm info', () => {
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

  const info = async (name: string, bytes: Uint8Array) => {
    await kernel.filesystem.fs.writeFile(`/tmp/${name}.wasm`, bytes, { mode: 0o755 })
    const code = await kernel.shell.execute(`wasm info /tmp/${name}.wasm > /tmp/${name}.out 2> /tmp/${name}.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile(`/tmp/${name}.out`, 'utf-8'),
      err: await kernel.filesystem.fs.readFile(`/tmp/${name}.err`, 'utf-8')
    }
  }

  it('names a module with no host calls, and a library', async () => {
    const plain = await info('plain', await compile(PLAIN))
    expect(plain.code).toBe(0)
    expect(plain.out).toContain('ABI: none')
    expect(plain.out).toContain('a program, started at _start')

    const library = await info('library', await compile(LIBRARY))
    expect(library.out).toContain('not a program')
  })

  it('lists the imports the Preview 1 and Emscripten hosts lack', async () => {
    const missing = await info('missing', await compile(MISSING))
    expect(missing.out).toContain('ABI: Emscripten (with WASI Preview 1 calls)')
    expect(missing.out).toContain('wasi_snapshot_preview1.no_such_call')
    expect(missing.out).toContain('env.log')
    expect(missing.out).not.toContain('wasi_snapshot_preview1.proc_exit')
  })

  it('knows a WASI Preview 1 program, an Emscripten one and a component', async () => {
    const c = await info('c-wasip1', fixture('c-wasip1.wasm'))
    expect(c.out).toContain('ABI: WASI Preview 1')
    expect(c.out).toContain('Not provided: none')

    const emcc = await info('emcc-hello', fixture('emcc-hello.wasm'))
    expect(emcc.out).toMatch(/ABI: Emscripten/)

    const component = await info('p2-echo', fixture('p2-echo.wasm'))
    expect(component.out).toContain('ABI: WASI Preview 2 (0.2), a component')
    expect(component.out).toContain('started at wasi:cli/run')
    expect(component.out).toContain('Not provided: none')
  })

  it('knows a WALI program, and the host it runs on provides all its calls', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const { join } = process.getBuiltinModule('node:path')
    const bc = await info('bc', new Uint8Array(readFileSync(join(__dirname, '../../../../utils/programs/bc.wasm'))))
    expect(bc.out).toContain('ABI: WALI')
    expect(bc.out).toContain('Not provided: none')
  })

  it('refuses a file that is not WebAssembly', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/plain.txt', 'hello', { mode: 0o755 })
    expect(await kernel.shell.execute('wasm info /tmp/plain.txt 2> /tmp/plain-txt.err')).toBe(1)
    expect(await kernel.filesystem.fs.readFile('/tmp/plain-txt.err', 'utf-8')).toBe('wasm: /tmp/plain.txt: not a WebAssembly file\n')
  })
})
