import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bindContext } from '@zenfs/core'
import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** The kernel owns the file mode creation mask, so these hold whatever the installed file system layer does. */
describe('umask', () => {
  let kernel: Kernel
  const mode = async (path: string) => (await kernel.filesystem.fs.stat(path)).mode & 0o7777
  const out = async (command: string) => {
    await kernel.shell.execute(`${command} > /tmp/umask-out 2> /tmp/umask-err`)
    return { out: await kernel.filesystem.fs.readFile('/tmp/umask-out', 'utf-8'), err: await kernel.filesystem.fs.readFile('/tmp/umask-err', 'utf-8') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  beforeEach(async () => {
    await kernel.shell.execute('umask 0 2> /dev/null')
    await kernel.filesystem.fs.rm('/tmp/um', { recursive: true, force: true })
    await kernel.filesystem.fs.mkdir('/tmp/um', { recursive: true })
  })

  it('/etc/profile sets the mask a login shell starts with, and is written once', async () => {
    const profile = await kernel.filesystem.fs.readFile('/etc/profile', 'utf-8')
    expect(profile).toMatch(/^umask 022/m)
  })

  it('prints the mask in octal, symbolically, and as a command', async () => {
    await kernel.shell.execute('umask 027')
    expect((await out('umask')).out).toBe('0027\n')
    expect((await out('umask -S')).out).toBe('u=rwx,g=rx,o=\n')
    expect((await out('umask -p')).out).toBe('umask 0027\n')
  })

  it('sets it symbolically, and refuses what is not a mask', async () => {
    await kernel.shell.execute('umask u=rwx,g=rx,o=rx')
    expect((await out('umask')).out).toBe('0022\n')
    const bad = await out('umask 9')
    expect(bad.err).toContain('invalid octal number')
    expect((await out('umask')).out).toBe('0022\n')
    expect(await kernel.shell.execute('umask a b 2> /dev/null')).toBe(1)
  })

  it('files and directories the shell makes through a redirect and its programs are created without the masked bits', async () => {
    await kernel.shell.execute('umask 077')
    await kernel.shell.execute('echo x > /tmp/um/redirected; touch /tmp/um/touched; mkdir /tmp/um/dir')
    expect(await mode('/tmp/um/redirected') & 0o077).toBe(0)
    expect(await mode('/tmp/um/touched')).toBe(0o600)
    expect(await mode('/tmp/um/dir')).toBe(0o700)
  }, 30000)

  it('umask 0 masks nothing, and the mask applies to the next command at once', async () => {
    await kernel.shell.execute('umask 022; mkdir /tmp/um/a; umask 0; mkdir /tmp/um/b')
    expect(await mode('/tmp/um/a')).toBe(0o755)
    expect(await mode('/tmp/um/b')).toBe(0o777)
  }, 30000)

  it('a mask of 0 leaves what touch creates at 0666', async () => {
    await kernel.shell.execute('umask 0; touch /tmp/um/loose')
    expect(await mode('/tmp/um/loose')).toBe(0o666)
  }, 30000)

  // The context field exists only in a file system layer that keeps a mask of its own
  it.skipIf(typeof (bindContext({}) as { umask?: number }).umask !== 'number')('pid 1 starts with 022, which everything under init inherits', async () => {
    const init = kernel.init.process as unknown as { context: { umask?: number } }
    expect(init.context.umask).toBe(0o022)
    const crond = [...processes.values()].find(proc => proc.comm === 'crond' && proc.code === undefined)!
    expect((crond.context as { umask?: number }).umask).toBe(0o022)
  }, 30000)

  it('cp makes its copy without the masked bits too', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/um/src', 'x', { mode: 0o755 })
    await kernel.filesystem.fs.chmod('/tmp/um/src', 0o755)
    await kernel.shell.execute('umask 027; cp /tmp/um/src /tmp/um/dst')
    expect(await mode('/tmp/um/dst')).toBe(0o750)
  }, 30000)

  it('survives the shell being rebound to another context, as login and su do', async () => {
    await kernel.shell.execute('umask 077')
    kernel.shell.context = bindContext({ root: '/', pwd: '/', credentials: kernel.shell.credentials })
    expect(kernel.shell.umask).toBe(0o077)
    expect((await out('umask')).out).toBe('0077\n')
  })

  it('ecmash has its own umask, which what it starts inherits and which does not reach the shell that ran it', async () => {
    await kernel.shell.execute('umask 0')
    const result = await out('ecmash -c "umask 077; touch /tmp/um/e1; ecmash -c \\"touch /tmp/um/e2\\"; umask"')
    expect(result.out).toBe('0077\n')
    expect(await mode('/tmp/um/e1')).toBe(0o600)
    expect(await mode('/tmp/um/e2')).toBe(0o600)
    expect(kernel.shell.umask).toBe(0)
  }, 60000)

  it('ecmash starts with the mask of the shell that ran it', async () => {
    await kernel.shell.execute('umask 027')
    expect((await out('ecmash -c umask')).out).toBe('0027\n')
  }, 30000)
})
