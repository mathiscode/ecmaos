import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('tar -C, rm -v and the initfs refresh', () => {
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

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out.txt 2> /tmp/err.txt`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/out.txt', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/err.txt', 'utf8') }
  }

  it('tar -x -C / unpacks relative to the root, and -C elsewhere still works', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/pack/tarroot-dir', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/pack/tarroot-dir/a.txt', 'hello\n')
    expect((await run('tar -czf /tmp/pack.tgz -C /tmp/pack .')).code).toBe(0)

    expect(await run('tar -xzf /tmp/pack.tgz -C /')).toMatchObject({ code: 0, err: '' })
    expect(await kernel.filesystem.fs.readFile('/tarroot-dir/a.txt', 'utf8')).toBe('hello\n')

    await kernel.filesystem.fs.mkdir('/tmp/elsewhere')
    expect(await run('tar -xzf /tmp/pack.tgz -C /tmp/elsewhere')).toMatchObject({ code: 0, err: '' })
    expect(await kernel.filesystem.fs.readFile('/tmp/elsewhere/tarroot-dir/a.txt', 'utf8')).toBe('hello\n')
  }, 60000)

  it('rm -v says what it removed', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/rmv/sub', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/rmv/a.txt', 'x')
    expect(await run('rm -v /tmp/rmv/a.txt')).toEqual({ code: 0, out: "removed '/tmp/rmv/a.txt'\n", err: '' })
    expect(await run('rm -rv /tmp/rmv')).toEqual({ code: 0, out: "removed directory '/tmp/rmv'\n", err: '' })
    expect((await run('rm --verbose /tmp/rmv-missing')).code).toBe(1)
    expect((await run('rm -fv /tmp/rmv-missing')).code).toBe(0)
  }, 60000)

  it('refreshes /usr/share from a changed initfs and leaves the rest of an existing filesystem alone', async () => {
    const pack = async (docs: string) => {
      await kernel.filesystem.fs.rm('/tmp/img', { recursive: true, force: true })
      await kernel.filesystem.fs.mkdir('/tmp/img/usr/share/vimtest', { recursive: true })
      await kernel.filesystem.fs.mkdir('/tmp/img/etc', { recursive: true })
      await kernel.filesystem.fs.writeFile('/tmp/img/usr/share/vimtest/doc.txt', docs)
      await kernel.filesystem.fs.writeFile('/tmp/img/etc/initfs-test.conf', docs)
      expect((await run('tar -czf /tmp/img.tgz -C /tmp/img .')).code).toBe(0)
      return new Uint8Array(await kernel.filesystem.fs.readFile('/tmp/img.tgz'))
    }
    let bytes = await pack('one')
    const install = () => (kernel.filesystem as unknown as { installInitfs(url: string, fetcher: () => Promise<Response>): Promise<void> }).installInitfs('/initfs.tar.gz', async () => new Response(bytes))

    await kernel.filesystem.fs.unlink('/etc/initfs-test.conf').catch(() => undefined)
    window.localStorage.removeItem('ecmaos:filesystem:initialized')
    await install() // a new filesystem gets everything
    expect(await kernel.filesystem.fs.readFile('/usr/share/vimtest/doc.txt', 'utf8')).toBe('one')
    expect(await kernel.filesystem.fs.readFile('/etc/initfs-test.conf', 'utf8')).toBe('one')

    await kernel.filesystem.fs.writeFile('/etc/initfs-test.conf', 'edited by the user')
    bytes = await pack('two')
    await install() // a changed one refreshes /usr/share only
    expect(await kernel.filesystem.fs.readFile('/usr/share/vimtest/doc.txt', 'utf8')).toBe('two')
    expect(await kernel.filesystem.fs.readFile('/etc/initfs-test.conf', 'utf8')).toBe('edited by the user')

    await kernel.filesystem.fs.writeFile('/usr/share/vimtest/doc.txt', 'local')
    await install() // an unchanged one does nothing
    expect(await kernel.filesystem.fs.readFile('/usr/share/vimtest/doc.txt', 'utf8')).toBe('local')
  }, 60000)
})
