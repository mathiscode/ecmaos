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

/** Runs a real module through `wasm-opt --asyncify` (binaryen), proving the adapter's claim by hand. */
function asyncify(bytes: Uint8Array): Uint8Array {
  const { execFileSync } = process.getBuiltinModule('node:child_process')
  const { mkdtempSync, writeFileSync, readFileSync } = process.getBuiltinModule('node:fs')
  const { tmpdir } = process.getBuiltinModule('node:os')
  const { join } = process.getBuiltinModule('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'wasi-asyncify-'))
  const inPath = join(dir, 'in.wasm')
  const outPath = join(dir, 'out.wasm')
  writeFileSync(inPath, Buffer.from(bytes))
  execFileSync(join(process.cwd(), '../../node_modules/.bin/wasm-opt'), [inPath, '--asyncify', '-o', outPath])
  return new Uint8Array(readFileSync(outPath))
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

// epoll_create1 -> epoll_ctl(ADD, fd 0, events=EPOLLIN, data=42) -> epoll_pwait(timeout=5000).
// Exit code encodes both the real readiness answer and that the registered epoll_data_t round
// tripped: n*100 + the ready event's data (expect 1*100 + 42 = 142 once stdin -- a pipe fed by the
// shell pipeline the test runs this under -- already has data buffered, so it is real, not stubbed).
const EPOLL_STDIN = `(module
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (import "env" "__syscall_epoll_create1" (func $epoll_create1 (param i32) (result i32)))
  (import "env" "__syscall_epoll_ctl" (func $epoll_ctl (param i32 i32 i32 i32) (result i32)))
  (import "env" "__syscall_epoll_pwait" (func $epoll_pwait (param i32 i32 i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start") (local $epfd i32) (local $n i32)
    (local.set $epfd (call $epoll_create1 (i32.const 0)))
    (i32.store (i32.const 200) (i32.const 1))
    (i64.store (i32.const 208) (i64.const 42))
    (drop (call $epoll_ctl (local.get $epfd) (i32.const 1) (i32.const 0) (i32.const 200)))
    (local.set $n (call $epoll_pwait (local.get $epfd) (i32.const 300) (i32.const 1) (i32.const 5000) (i32.const 0) (i32.const 0)))
    (call $proc_exit (i32.add (i32.mul (local.get $n) (i32.const 100)) (i32.wrap_i64 (i64.load (i32.const 308)))))))`

// same as HELLO, but the memory is imported rather than exported -- proves `runPreview1`'s own
// `detectMemoryImport` (reading the import's declared size straight out of the binary, since the
// JS reflection API doesn't expose memory limits) actually creates and wires it in.
const HELLO_IMPORTED_MEMORY = `(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (import "env" "memory" (memory 2))
  (data (i32.const 8) "hi from imported\\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 8))
    (i32.store (i32.const 4) (i32.const 17))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 100)))
    (call $proc_exit (i32.const 5))))`

// Binds/listens/accepts a loopback AF_INET socket on 127.0.0.1:9000, reads what the client sends,
// writes "pong\n" back, exits with the byte count it read (expect 5, "hello"'s length). Signals
// "past listen(), ready to accept" by creating tmp/socket-ready through the same env.__syscall_openat
// the real emcc fixture already proved, since there is no other way for the test to know listen()
// has actually happened before the client tries to connect.
const SOCKET_SERVER = `(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (import "env" "__syscall_socket" (func $socket (param i32 i32 i32) (result i32)))
  (import "env" "__syscall_bind" (func $bind (param i32 i32 i32) (result i32)))
  (import "env" "__syscall_listen" (func $listen (param i32 i32) (result i32)))
  (import "env" "__syscall_accept4" (func $accept4 (param i32 i32 i32 i32) (result i32)))
  (import "env" "__syscall_openat" (func $openat (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 2)
  (data (i32.const 200) "\\02\\00\\23\\28\\00\\00\\00\\00")
  (data (i32.const 300) "tmp/socket-ready")
  (data (i32.const 2000) "pong\\n")
  (func (export "_start") (local $sfd i32) (local $cfd i32)
    (local.set $sfd (call $socket (i32.const 2) (i32.const 1) (i32.const 0)))
    (if (i32.lt_s (call $bind (local.get $sfd) (i32.const 200) (i32.const 16)) (i32.const 0))
      (then (call $proc_exit (i32.const 10))))
    (if (i32.lt_s (call $listen (local.get $sfd) (i32.const 1)) (i32.const 0))
      (then (call $proc_exit (i32.const 11))))
    (drop (call $openat (i32.const -100) (i32.const 300) (i32.const 577) (i32.const 0)))
    (local.set $cfd (call $accept4 (local.get $sfd) (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.lt_s (local.get $cfd) (i32.const 0)) (then (call $proc_exit (i32.const 12))))
    (i32.store (i32.const 0) (i32.const 1000))
    (i32.store (i32.const 4) (i32.const 64))
    (drop (call $fd_read (local.get $cfd) (i32.const 0) (i32.const 1) (i32.const 100)))
    (i32.store (i32.const 8) (i32.const 2000))
    (i32.store (i32.const 12) (i32.const 5))
    (drop (call $fd_write (local.get $cfd) (i32.const 8) (i32.const 1) (i32.const 104)))
    (call $proc_exit (i32.load (i32.const 100)))))`

// Connects to 127.0.0.1:9000, sends "hello", echoes whatever comes back to its own stdout.
const SOCKET_CLIENT = `(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (import "env" "__syscall_socket" (func $socket (param i32 i32 i32) (result i32)))
  (import "env" "__syscall_connect" (func $connect (param i32 i32 i32) (result i32)))
  (memory (export "memory") 2)
  (data (i32.const 200) "\\02\\00\\23\\28\\7f\\00\\00\\01")
  (data (i32.const 2000) "hello")
  (func (export "_start") (local $sfd i32)
    (local.set $sfd (call $socket (i32.const 2) (i32.const 1) (i32.const 0)))
    (if (i32.lt_s (call $connect (local.get $sfd) (i32.const 200) (i32.const 16)) (i32.const 0))
      (then (call $proc_exit (i32.const 20))))
    (i32.store (i32.const 8) (i32.const 2000))
    (i32.store (i32.const 12) (i32.const 5))
    (drop (call $fd_write (local.get $sfd) (i32.const 8) (i32.const 1) (i32.const 104)))
    (i32.store (i32.const 0) (i32.const 1000))
    (i32.store (i32.const 4) (i32.const 64))
    (drop (call $fd_read (local.get $sfd) (i32.const 0) (i32.const 1) (i32.const 100)))
    (i32.store (i32.const 8) (i32.const 1000))
    (i32.store (i32.const 12) (i32.load (i32.const 100)))
    (drop (call $fd_write (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 104)))
    (call $proc_exit (i32.const 0))))`

describe('wasi preview1 as a worker Process', () => {
  let kernel: Kernel

  // A real, ordinary (non-STANDALONE_WASM) emcc 6.0.9 build, run end to end through the worker:
  // stdout, a real file created/written/closed via env.__syscall_openat/fd_write/fd_close, its size
  // read back correctly via __syscall_stat64, a real directory via __syscall_mkdirat, and the
  // program's own exit code. This is also the regression test for a real bug caught building it:
  // the '.' preopen used to reserve a fixed wasi-fd number that a real env.__syscall_openat call
  // could (and here did) collide with, silently corrupting the write -- see wasi-preview1.mjs's own
  // doc comment.
  it('runs a real emcc build: writes to stdout, creates a file and a directory through env.__syscall_*, exits its own code', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const { join } = process.getBuiltinModule('node:path')
    const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'tests/tree/wasi/fixtures/emcc-hello.wasm')))
    expect(await kernel.wasm.canRunInWorker(bytes)).toBe(true)

    await kernel.filesystem.fs.writeFile('/tmp/emcc-hello.wasm', bytes, { mode: 0o755 })
    expect(await kernel.shell.execute('/tmp/emcc-hello.wasm > /tmp/emcc-hello.out 2> /tmp/emcc-hello.err')).toBe(3)
    const out = await kernel.filesystem.fs.readFile('/tmp/emcc-hello.out', 'utf-8')
    expect(out).toContain('hello from emscripten')
    expect(out).toContain('size=11')
    expect(await kernel.filesystem.fs.readFile('/tmp/emtest-out.txt', 'utf-8')).toBe('wrote this\n')
    expect((await kernel.filesystem.fs.stat('/tmp/emtest-dir')).isDirectory()).toBe(true)
  })


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

  it('runs a module with an imported (not exported) memory, created to its own declared size', async () => {
    const bytes = await compile(HELLO_IMPORTED_MEMORY)
    expect(await kernel.wasm.canRunInWorker(bytes)).toBe(true)
    await kernel.filesystem.fs.writeFile('/tmp/hello-imported-memory.wasm', bytes, { mode: 0o755 })
    expect(await kernel.shell.execute('/tmp/hello-imported-memory.wasm > /tmp/hello-imported-memory.out')).toBe(5)
    expect(await kernel.filesystem.fs.readFile('/tmp/hello-imported-memory.out', 'utf-8')).toBe('hi from imported\n')
  })

  it('epoll_create1/epoll_ctl/epoll_pwait see a real pipe\'s real readiness, and epoll_data_t round trips', async () => {
    const bytes = await compile(EPOLL_STDIN)
    expect(await kernel.wasm.canRunInWorker(bytes)).toBe(true)
    await kernel.filesystem.fs.writeFile('/tmp/epoll-stdin.wasm', bytes, { mode: 0o755 })
    expect(await kernel.shell.execute('echo hi | /tmp/epoll-stdin.wasm')).toBe(142)
  })

  it('binds/listens/accepts and connects a real loopback socket, exchanging data both ways', async () => {
    const serverBytes = await compile(SOCKET_SERVER)
    const clientBytes = await compile(SOCKET_CLIENT)
    expect(await kernel.wasm.canRunInWorker(serverBytes)).toBe(true)
    expect(await kernel.wasm.canRunInWorker(clientBytes)).toBe(true)
    await kernel.filesystem.fs.writeFile('/tmp/socket-server.wasm', serverBytes, { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/tmp/socket-client.wasm', clientBytes, { mode: 0o755 })

    const exists = async (path: string) => { try { await kernel.filesystem.fs.stat(path); return true } catch { return false } }

    const serverRun = kernel.shell.execute('/tmp/socket-server.wasm')
    for (let i = 0; i < 100 && !(await exists('/tmp/socket-ready')); i++) await new Promise(resolve => setTimeout(resolve, 50))
    expect(await exists('/tmp/socket-ready')).toBe(true)

    expect(await kernel.shell.execute('/tmp/socket-client.wasm > /tmp/socket-client.out')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/socket-client.out', 'utf-8')).toBe('pong\n')
    expect(await serverRun).toBe(5)
  })

  it('a connect to a non-loopback address fails cleanly instead of crashing', async () => {
    const NON_LOOPBACK = `(module
      (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
      (import "env" "__syscall_socket" (func $socket (param i32 i32 i32) (result i32)))
      (import "env" "__syscall_connect" (func $connect (param i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 200) "\\02\\00\\00\\50\\08\\08\\08\\08")
      (func (export "_start") (local $sfd i32) (local $rc i32)
        (local.set $sfd (call $socket (i32.const 2) (i32.const 1) (i32.const 0)))
        (local.set $rc (call $connect (local.get $sfd) (i32.const 200) (i32.const 16)))
        (call $proc_exit (i32.eqz (i32.lt_s (local.get $rc) (i32.const 0))))))`
    const bytes = await compile(NON_LOOPBACK)
    expect(await kernel.wasm.canRunInWorker(bytes)).toBe(true)
    await kernel.filesystem.fs.writeFile('/tmp/socket-nonloopback.wasm', bytes, { mode: 0o755 })
    // exit code 0 means connect() returned a real negative errno (never crashed, never silently succeeded)
    expect(await kernel.shell.execute('/tmp/socket-nonloopback.wasm')).toBe(0)
  })

  it('is routed to the worker only when it is a plain wasip1 module', async () => {
    expect(await kernel.wasm.canRunInWorker(await compile(HELLO))).toBe(true)
    const emscripten = await compile(`(module (import "env" "emscripten_thing" (func)) (memory (export "memory") 1) (func (export "_start")))`)
    expect(await kernel.wasm.canRunInWorker(emscripten)).toBe(false)
  })

  it('runs an asyncify-instrumented module the same as the plain one, unwind/rewind never triggered', async () => {
    const instrumented = asyncify(await compile(HELLO))
    // The transform adds only the asyncify_* exports, no new imports -- confirms the adapter's claim
    // that it stays routable (no env.* import shows up asyncify needs answering).
    const module = await WebAssembly.compile(instrumented.buffer.slice(instrumented.byteOffset, instrumented.byteOffset + instrumented.byteLength) as ArrayBuffer)
    expect(WebAssembly.Module.imports(module).every(entry => entry.module === 'wasi_snapshot_preview1')).toBe(true)
    expect(WebAssembly.Module.exports(module).some(entry => entry.name === 'asyncify_get_state')).toBe(true)

    expect(await kernel.wasm.canRunInWorker(instrumented)).toBe(true)
    await kernel.filesystem.fs.writeFile('/tmp/hello-async.wasm', instrumented, { mode: 0o755 })
    expect(await kernel.shell.execute('/tmp/hello-async.wasm > /tmp/hello-async.out')).toBe(7)
    expect(await kernel.filesystem.fs.readFile('/tmp/hello-async.out', 'utf-8')).toBe('hello from wasi\n')
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
