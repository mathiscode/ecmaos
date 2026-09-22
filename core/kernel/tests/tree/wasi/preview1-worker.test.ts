import { beforeAll, describe, expect, it } from 'vitest'
import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A plain `wasm32-wasip1` module runs as a real worker-hosted Process under `/bin/wali`'s preview1
 * translation (`src/bin/wasi-preview1.mjs`): real pid, real stdio fds, real exit codes, and, the
 * point of the change, killable while it spins in a tight loop with no yield point.
 */
async function compile(wat: string): Promise<Uint8Array> {
  const wabt = await (await import('wabt')).default()
  const parsed = wabt.parseWat('fixture.wat', wat)
  const { buffer } = parsed.toBinary({})
  parsed.destroy()
  return buffer
}

const HEADER = `
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
`

const HELLO = `(module ${HEADER}
  (data (i32.const 8) "hello from wasi\\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 8))
    (i32.store (i32.const 4) (i32.const 16))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 100)))
    (call $proc_exit (i32.const 7))))`

// copies stdin to stdout until EOF
const CAT = `(module ${HEADER}
  (func (export "_start") (local $n i32)
    (block $done
      (loop $again
        (i32.store (i32.const 0) (i32.const 64))
        (i32.store (i32.const 4) (i32.const 1024))
        (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 100)))
        (local.set $n (i32.load (i32.const 100)))
        (br_if $done (i32.eqz (local.get $n)))
        (i32.store (i32.const 4) (local.get $n))
        (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 104)))
        (br $again)))))`

// creates /tmp/wasi-made.txt through the "/" preopen (fd 3), writes to it, then lists nothing else
const WRITE_FILE = `(module
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 200) "tmp/wasi-made.txt")
  (data (i32.const 300) "made by wasi")
  (func (export "_start")
    (if (call $path_open (i32.const 3) (i32.const 0) (i32.const 200) (i32.const 17) (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 400))
      (then (call $proc_exit (i32.const 9))))
    (i32.store (i32.const 0) (i32.const 300))
    (i32.store (i32.const 4) (i32.const 12))
    (drop (call $fd_write (i32.load (i32.const 400)) (i32.const 0) (i32.const 1) (i32.const 100)))
    (drop (call $fd_close (i32.load (i32.const 400))))))`

const SPIN = `(module ${HEADER}
  (func (export "_start") (loop $forever (br $forever))))`

describe('wasi preview1 as a worker Process', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    for (const [name, wat] of Object.entries({ hello: HELLO, cat: CAT, spin: SPIN, writefile: WRITE_FILE })) {
      await kernel.filesystem.fs.writeFile(`/tmp/${name}.wasm`, await compile(wat), { mode: 0o755 })
    }
  })

  it('is routed to the worker only when it is a plain wasip1 module', async () => {
    expect(await kernel.wasm.canRunInWorker(await compile(HELLO))).toBe(true)
    const emscripten = await compile(`(module (import "env" "emscripten_thing" (func)) (memory (export "memory") 1) (func (export "_start")))`)
    expect(await kernel.wasm.canRunInWorker(emscripten)).toBe(false)
  })

  it('writes to stdout and exits with its own code', async () => {
    const code = await kernel.shell.execute('/tmp/hello.wasm > /tmp/hello.out')
    expect(code).toBe(7)
    expect(await kernel.filesystem.fs.readFile('/tmp/hello.out', 'utf-8')).toBe('hello from wasi\n')
  })

  it('reads a pipe and writes a pipe, past the 64 KiB pipe buffer', async () => {
    const big = 'x'.repeat(200_000)
    await kernel.filesystem.fs.writeFile('/tmp/big.txt', big)
    expect(await kernel.shell.execute('cat /tmp/big.txt | /tmp/cat.wasm | wc -c > /tmp/cat.count')).toBe(0)
    expect((await kernel.filesystem.fs.readFile('/tmp/cat.count', 'utf-8')).trim()).toBe('200000')
  })

  it('creates and writes a file through a path_open on the root preopen', async () => {
    expect(await kernel.shell.execute('/tmp/writefile.wasm')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/wasi-made.txt', 'utf-8')).toBe('made by wasi')
  })

  it('is a real process: a tight loop with no yield point shows in the table and dies to kill', async () => {
    const running = kernel.shell.execute('/tmp/spin.wasm')
    let entry: { pid: number } | undefined
    for (let i = 0; i < 100 && !entry; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      entry = [...processes.values()].find(p => p.comm.endsWith('spin.wasm') || p.argv?.[0]?.endsWith('spin.wasm'))
    }
    expect(entry).toBeDefined()
    expect(await kernel.shell.execute(`kill -9 ${entry!.pid}`)).toBe(0)
    const code = await Promise.race([running, new Promise<string>(resolve => setTimeout(() => resolve('hung'), 5000))])
    expect(code).not.toBe('hung')
  })
})
