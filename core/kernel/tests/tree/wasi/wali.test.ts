import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * Programs built on WALI's musl (`utils/check-wali.sh`; the fixtures are rebuilt by `fixtures/wali.build.sh`) run as
 * worker processes under `/bin/wali`, on the dependency's WALI host with ecmaOS's calls added (`src/bin/wali-host.mjs`).
 */
describe('WALI programs', () => {
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

  const run = async (fixture: string, command = `/tmp/${fixture}`) => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/${fixture}.wasm`)
    await kernel.filesystem.fs.writeFile(`/tmp/${fixture}`, new Uint8Array(bytes), { mode: 0o755 })
    const code = await kernel.shell.execute(`${command} > /tmp/${fixture}.out 2> /tmp/${fixture}.err`)
    const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf8')
    return { code, out: await read(`/tmp/${fixture}.out`), err: await read(`/tmp/${fixture}.err`) }
  }

  it('is recognized as WALI and runs in a worker', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/wali-libc.wasm`)
    expect(await kernel.wasm.isWali(bytes)).toBe(true)
    expect(await kernel.wasm.canRunInWorker(bytes)).toBe(true)
    const emcc = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/emcc-hello.wasm`)
    expect(await kernel.wasm.isWali(emcc)).toBe(false)
  })

  it('gets its arguments and environment, and the C library reaches the filesystem through the host', async () => {
    expect(await run('wali-libc', 'WALI_FIXTURE=yes /tmp/wali-libc one')).toEqual({
      code: 3,
      err: '',
      out: [
        'argc=2 argv1=one env=yes',
        'enoent=1',
        'fstatat=0 size=12',
        'empty_path=0 dir=1',
        'mkdirat=0 unlinkat=0',
        // 40 files and made.txt; zenfs lists no . or ..
        'readdir=41 again=41',
        'mmap=mapped text',
        'getfl=1 cloexec=0 set=1 dup3=20 1 high=1',
        'malloc ok',
        ''
      ].join('\n')
    })
  }, 30_000)

  it('jumps with setjmp and longjmp', async () => {
    expect(await run('wali-setjmp')).toEqual({
      code: 0,
      err: '',
      out: 'longjmp from 5 calls down: 42\nlongjmp(0) arrives as 1 after 1\n'
    })
  }, 30_000)

  it('runs C++ with exceptions, the standard library and std::filesystem', async () => {
    expect(await run('wali-cxx')).toEqual({
      code: 0,
      err: '',
      out: 'caught from below, 4 destructors ran\ncaught int 7\nmap size 2, b=2\ndirectories 2\n'
    })
  }, 30_000)

  it('spawns, waits, execs and handles signals', async () => {
    expect(await run('wali-proc')).toEqual({
      code: 0,
      err: '',
      out: [
        'addopen: exit=7 wrote=from the child',
        'pipe: from the child',
        'cloexec: plain open, cloexec closed',
        'execve: exit=0 plain open, cloexec closed',
        'wnohang: 0 then pid, exit=3',
        'signaled: 1 sig=15',
        'spawnp: 0 exit=3 missing=No such file or directory',
        'system: exit=5 popen: through the shell pclose=0',
        'raise: 1 blocked: 1 pending=1 unblocked: 2 ignored usr2: alive',
        'inherited: exit=0 usr2 survived, usr1 blocked=1',
        'sigchld: 1 wait=pid',
        'alarm: handled=2 sleep left 4 of 5, pause returned',
        ''
      ].join('\n')
    })
  }, 60_000)

  it('talks over sockets: pairs, AF_UNIX and loopback TCP between processes, poll, epoll and SIGPIPE', async () => {
    expect(await run('wali-net')).toEqual({
      code: 0,
      err: '',
      out: [
        'socketpair: ping pong peek=ping fionread=4 eof=0 sock=1',
        'unix reply: HELLO OVER THE SOCKET',
        'unix: bind=0 listen=0 poll=1 revents=1 exit=0',
        'tcp reply: HELLO OVER THE SOCKET',
        'tcp: port>0=1 peer=127.0.0.1 family=2 exit=0',
        'nonblock: accept=-1 EAGAIN recv=-1 EAGAIN pipe=-1 EAGAIN getfl=1',
        'epoll: add=0 before=0 after=1 events=1 data=1234567890 again=1',
        'inherited: said through an inherited socket',
        'sigpipe: write=-1 EPIPE child signaled=1 sig=13',
        'refused: -1 ECONNREFUSED',
        ''
      ].join('\n')
    })
  }, 60_000)

  it('keeps a shared file mapping in step with the file across processes', async () => {
    expect(await run('wali-shared')).toEqual({
      code: 0,
      err: '',
      out: 'child read: from shell\nparent sees: from child\nafter munmap: third page\npipe: refused\n'
    })
  }, 60_000)

  it('drives a pty and does job control: stops, SIGCONT, and reading the terminal from the background', async () => {
    expect(await run('wali-tty')).toEqual({
      code: 0,
      err: '',
      out: [
        'pty: grant=0 unlock=0 name=/dev/pts/N tty=1',
        'winsize: 30x100',
        'output: cooked crlf=1 raw lf=1 icanon=0',
        'input: read=1 key=k',
        'tstp: stopped=1 sig=20',
        'child continued, handler=1',
        'tstp: exit=0',
        'sigstop: stopped=1 sig=19 exit=4',
        'background read: stopped by SIGTTIN, foreground=1',
        'ignored SIGTTIN: read=-1 EIO',
        'background read: exit=5',
        ''
      ].join('\n')
    })
  }, 60_000)

  it('runs threads on one memory: mutexes, condition variables, TLS, malloc from many at once, detached threads and exit()', async () => {
    expect(await run('wali-thread')).toEqual({
      code: 0,
      err: '',
      out: [
        'mutex: counter=80000 returned=360 tls main=0',
        'condvar: passes=100',
        'malloc: 8000 of 8000 blocks intact',
        'detached: 5 threads wrote',
        'ids: same pid=1 other tid=1',
        'exit from a thread: exit=9',
        ''
      ].join('\n')
    })
  }, 120_000)

  it('ends by SIGABRT when an exception is not caught', async () => {
    expect(await run('wali-uncaught')).toEqual({ code: 134, err: 'terminating due to an uncaught exception\n', out: '' })
  }, 30_000)
})
