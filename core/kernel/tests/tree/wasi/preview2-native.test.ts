import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A component built by rustc for wasm32-wasip2 (fixtures/rust-p2.rs): it imports wasi:* 0.2 directly, so these run the
 * worker's interface host for filesystem, clocks, sockets and name lookup, which the adapter-made components do not reach.
 */
describe('a native WASI Preview 2 component', () => {
  let kernel: Kernel
  const program = '/tmp/rust-p2-native.wasm'

  const run = async (line: string, input = '/dev/null') => {
    const code = await kernel.shell.execute(`${line} < ${input} > /tmp/p2n.out 2> /tmp/p2n.err`)
    return {
      code,
      stdout: await kernel.filesystem.fs.readFile('/tmp/p2n.out', 'utf-8'),
      stderr: await kernel.filesystem.fs.readFile('/tmp/p2n.err', 'utf-8')
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
    await kernel.filesystem.fs.writeFile(program, new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/rust-p2-native.wasm`)), { mode: 0o755 })
  })

  it('runs: arguments, files, directories, a sleep, tcp, udp, a name lookup, stdin and an exit status', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/p2n.in', 'typed\n')
    const { code, stdout, stderr } = await run(`${program} stdin /tmp`, '/tmp/p2n.in')
    expect(stderr).toBe('rust-p2: stderr\n')
    expect(stdout).toBe([
      'args=stdin,/tmp', 'home=/root', 'file=made by rust p2', 'size=16', 'dir=a.txt,b.txt,sub', 'renamed=true', 'missing=true',
      'clock=true', 'slept=true', 'tcp=ping', 'udp=datagram', 'localhost=true', 'stdin=typed\n'
    ].join('\n'))
    expect(code).toBe(0)
  }, 60_000)

  it('exits with the status the program gives', async () => {
    expect((await run(`${program} 3 /tmp`)).code).toBe(1)
  }, 60_000)
})
