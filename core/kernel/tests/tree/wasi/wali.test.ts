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

  it('ends by SIGABRT when an exception is not caught', async () => {
    expect(await run('wali-uncaught')).toEqual({ code: 134, err: 'terminating due to an uncaught exception\n', out: '' })
  }, 30_000)
})
