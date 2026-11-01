import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_COREUTILS, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** Named pipes: mkfifo, mknod p, and a node whose readers and writers meet on one pipe */
describe('named pipes', () => {
  let kernel: Kernel
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_COREUTILS })
    await kernel.boot()
    await kernel.whenProgramsReady()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    await sleep(100)
  }, 60_000)

  it('mkfifo makes a node of type pipe, with the mode and the umask', async () => {
    expect((await run('mkfifo /tmp/f1')).code).toBe(0)
    const stat = await fs().stat('/tmp/f1')
    expect(stat.isFIFO()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o644)
    expect((await run('mkfifo -m 600 /tmp/f2')).code).toBe(0)
    expect((await fs().stat('/tmp/f2')).mode & 0o777).toBe(0o600)
    expect((await run('test -p /tmp/f1')).code).toBe(0)
    expect((await run('ls -l /tmp/f1')).out).toMatch(/^p/)
    const again = await run('mkfifo /tmp/f1')
    expect(again.code).toBe(1)
    expect(again.err).toBe("mkfifo: cannot create fifo '/tmp/f1': File exists\n")
    await run('rm /tmp/f1 /tmp/f2')
    expect(await fs().exists('/tmp/f1')).toBe(false)
  })

  it('a writer and a reader meet on the node', async () => {
    await run('mkfifo /tmp/talk')
    await kernel.shell.execute('echo through the pipe > /tmp/talk &')
    expect((await run('cat /tmp/talk')).out).toBe('through the pipe\n')
    await run('rm /tmp/talk')
  }, 20_000)

  it('a reader sees end of file when the last writer closes, and a later open starts empty', async () => {
    await run('mkfifo /tmp/seq')
    await kernel.shell.execute('(echo one; echo two) > /tmp/seq &')
    expect((await run('cat /tmp/seq')).out).toBe('one\ntwo\n')
    await kernel.shell.execute('echo three > /tmp/seq &')
    expect((await run('cat /tmp/seq')).out).toBe('three\n')
    await run('rm /tmp/seq')
  }, 20_000)

  it('a group redirected to the node keeps one writer, so its reader waits out a pause between the commands', async () => {
    await run('mkfifo /tmp/group')
    await kernel.shell.execute('(echo first; sleep 1; echo second) > /tmp/group &')
    expect((await run('cat /tmp/group')).out).toBe('first\nsecond\n')
    await run('rm /tmp/group')
  }, 20_000)

  it('opening for both reading and writing does not wait', async () => {
    await run('mkfifo /tmp/duplex')
    const script = "const fs = require('fs'); const fd = fs.openSync('/tmp/duplex', 'r+'); fs.writeSync(fd, 'held\\n'); const b = Buffer.alloc(16); const n = fs.readSync(fd, b, 0, 16, null); console.log(b.toString('utf8', 0, n).trim()); fs.closeSync(fd)"
    await fs().writeFile('/tmp/duplex.js', script)
    const result = await run('node /tmp/duplex.js')
    expect(result.out).toBe('held\n')
    await run('rm /tmp/duplex')
  }, 20_000)

  it('mknod makes a pipe, and refuses what needs a driver', async () => {
    expect((await run('mknod /tmp/n1 p')).code).toBe(0)
    expect((await fs().stat('/tmp/n1')).isFIFO()).toBe(true)
    const device = await run('mknod /tmp/n2 c 1 3')
    expect(device.code).toBe(1)
    expect(device.err).toBe('mknod: /tmp/n2: Operation not permitted\n')
    expect((await run('mknod /tmp/n3 p 1 2')).err).toMatch(/Fifos do not have major and minor/)
    await run('rm /tmp/n1')
  })
})
