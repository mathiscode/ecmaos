import { beforeAll, describe, expect, it } from 'vitest'
import { processes } from '@zenfs/linux'

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

  const waitFor = async (check: () => boolean, timeoutMs = 20000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

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

  it('runs threads on one memory: mutexes, condition variables, TLS, malloc from many at once, detached threads, and exit() or a trap in a thread', async () => {
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
        'trap in a thread: exit=1',
        ''
      ].join('\n')
    })
  }, 120_000)

  it('gets its signals while computing: a handler runs mid-loop, and a stopped process stays stopped', async () => {
    // the child stopped while computing goes to wait in a syscall, which the kernel holds, rather than computing on
    // (before its parent sends it the signal whose handler would end its loop)
    const stoppedChild = () => [...processes.values()].find(proc => proc.argv[1] === 'spin' && proc.stopped && proc.code === undefined)
    const waiting = (async () => {
      await waitFor(() => !!stoppedChild())
      const control = (stoppedChild()!.thread as unknown as { control: { status: Int32Array } }).control
      // 0: the page's status while its thread waits on a syscall (upstream's `SyscallStatus.Pending`)
      await waitFor(() => Atomics.load(control.status, 0) === 0, 200)
      return true
    })().catch(() => false)
    expect(await run('wali-busy')).toEqual({
      code: 0,
      err: '',
      out: [
        'alarm while computing: fired=1',
        'leaf: locals intact=1',
        'child computing: ready=1 exit=7',
        'stopped computing: stopped=1 held=1 exit=7',
        ''
      ].join('\n')
    })
    expect(await waiting).toBe(true)
  }, 60_000)

  it('has real-time signals: queued, between threads, waited for, and ending a process that does not handle one', async () => {
    expect(await run('wali-rtsig')).toEqual({
      code: 0,
      err: '',
      out: [
        'range: SIGRTMIN=35 SIGRTMAX=64',
        'raise: delivered=1000 failed=0',
        'queued while blocked: real-time=5 SIGUSR1=1',
        'pthread_kill to a thread computing: delivered=100 failed=0',
        'sigwaitinfo: 3 3 signo=3, then timed out=1',
        'sigqueue: delivered=1',
        'unhandled: signaled=1 by=5',
        ''
      ].join('\n')
    })
  }, 60_000)

  it('ends by SIGABRT when an exception is not caught', async () => {
    expect(await run('wali-uncaught')).toEqual({ code: 134, err: 'terminating due to an uncaught exception\n', out: '' })
  }, 30_000)
})
