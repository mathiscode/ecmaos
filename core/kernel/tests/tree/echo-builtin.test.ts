import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `echo` is a shell builtin, as in bash, and still writes through redirections and pipes. */
describe('the echo builtin', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  const out = async (command: string) => {
    expect(await kernel.shell.execute(`${command} > /tmp/echo-out 2>&1`)).toBe(0)
    return await kernel.filesystem.fs.readFile('/tmp/echo-out', 'utf-8')
  }

  it('is reported as a shell builtin', async () => {
    expect(await out('type echo')).toBe('echo is a shell builtin\n')
  })

  it('writes to a file, through a pipe, and reads escapes with -e', async () => {
    expect(await out('echo hi')).toBe('hi\n')
    expect(await out('echo piped | cat')).toBe('piped\n')
    expect(await out('echo -e "x\\ty"')).toBe('x\ty\n')
    expect(await out('echo --help')).toBe('--help\n')
  })

  it('appends to a new file through env, which opens the target twice', async () => {
    try { await kernel.filesystem.fs.unlink('/tmp/echo-new') } catch { /* absent */ }
    expect(await kernel.shell.execute('env echo hey >> /tmp/echo-new')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/echo-new', 'utf-8')).toBe('hey\n')
  })

  it('writes into the pipe an eval sits in', async () => {
    expect(await out(`eval 'echo x; echo y' | grep y`)).toBe('y\n')
  })

  it('the program is still there for /bin/echo', async () => {
    expect(await out('/bin/echo plain')).toBe('plain\n')
  })
})
