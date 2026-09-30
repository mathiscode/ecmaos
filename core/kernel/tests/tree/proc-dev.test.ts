import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `/dev/fd` and `/dev/std{in,out,err}`. These names existed only inside the WASI shim before; a
 * shell script that says `tee /dev/stderr` or `cat /dev/stdin` found nothing.
 */
describe('/dev descriptor links', () => {
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

  const fs = () => kernel.filesystem.fs
  const run = (line: string) => kernel.shell.execute(line)

  it('lays down the links Linux ships', async () => {
    expect(await fs().readlink('/dev/fd')).toBe('/proc/self/fd')
    expect(await fs().readlink('/dev/stdin')).toBe('/proc/self/fd/0')
    expect(await fs().readlink('/dev/stdout')).toBe('/proc/self/fd/1')
    expect(await fs().readlink('/dev/stderr')).toBe('/proc/self/fd/2')
  })

  it('reads a redirected stdin through /dev/stdin', async () => {
    await fs().writeFile('/tmp/devfd-in', 'from stdin\n')
    await run('cat /dev/stdin < /tmp/devfd-in > /tmp/devfd-out')
    expect(await fs().readFile('/tmp/devfd-out', 'utf-8')).toBe('from stdin\n')
  })

  it('writes to a redirected stdout through /dev/stdout', async () => {
    await run('echo viaout > /tmp/devfd-a')
    await run('tee /dev/stdout < /tmp/devfd-a > /tmp/devfd-b')
    expect(await fs().readFile('/tmp/devfd-b', 'utf-8')).toBe('viaout\nviaout\n')
  })

  it('writes to a redirected stderr through /dev/stderr', async () => {
    await run('echo viaerr > /tmp/devfd-c')
    await run('tee /dev/stderr < /tmp/devfd-c > /dev/null 2> /tmp/devfd-d')
    expect(await fs().readFile('/tmp/devfd-d', 'utf-8')).toBe('viaerr\n')
  })
})

describe('ps and killall read /proc', () => {
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

  it('lists itself with a parent and a uid, from /proc', async () => {
    await kernel.shell.execute('ps > /tmp/ps-proc.out')
    const lines = (await kernel.filesystem.fs.readFile('/tmp/ps-proc.out', 'utf-8')).trim().split('\n')
    expect(lines[0]).toBe('PID\tPPID\tUID\tCOMMAND')
    const own = lines.slice(1).map(line => line.split('\t')).find(cols => cols[3] === 'ps')
    expect(own).toBeDefined()
    expect(Number(own![0])).toBeGreaterThan(0)
    expect(own![2]).toBe('0')
  })

  it('killall reports a name nothing is running under', async () => {
    const code = await kernel.shell.execute('killall no-such-thing 2> /tmp/killall-proc.out')
    expect(code).toBe(1)
    expect(await kernel.filesystem.fs.readFile('/tmp/killall-proc.out', 'utf-8')).toContain('no process found')
  })
})
