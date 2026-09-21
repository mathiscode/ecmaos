import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * zip and unzip as real execve programs. `@zip.js/zip.js` (~330KB bundled) used to be kept out of
 * worker programs by a belief in an import-size limit; that was a filesystem bug (see filesystem.ts),
 * so these prove the library runs in a worker with `useWebWorkers: false` and real stdio/cwd syscalls.
 */
describe('zip and unzip, real execve', () => {
  let kernel: Kernel
  const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf-8')

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()

    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  it('are real execve files, not legacy stubs', async () => {
    for (const name of ['zip', 'unzip']) {
      expect((await read(`/bin/${name}`)).startsWith('#!ecmaos:bin:command:')).toBe(false)
    }
  })

  it('zips a tree recursively, lists it, and unzips it back byte for byte', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/zsrc/sub', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/zsrc/a.txt', 'hello')
    await kernel.filesystem.fs.writeFile('/tmp/zsrc/sub/b.txt', 'world'.repeat(50000))

    expect(await kernel.shell.execute('cd /tmp && zip -rv z.zip zsrc > /tmp/zip.out')).toBe(0)
    const zipOut = await read('/tmp/zip.out')
    expect(zipOut).toContain('adding: zsrc/a.txt')
    expect(zipOut).toContain('adding: zsrc/sub/b.txt')

    expect(await kernel.shell.execute('cd /tmp && unzip -l z.zip > /tmp/zlist.out')).toBe(0)
    const listing = await read('/tmp/zlist.out')
    expect(listing).toContain('zsrc/a.txt')
    expect(listing).toContain('2 files')

    expect(await kernel.shell.execute('cd /tmp && unzip -d /tmp/zdest z.zip > /tmp/unzip.out')).toBe(0)
    expect(await read('/tmp/unzip.out')).toContain('2 files extracted')
    expect(await read('/tmp/zdest/zsrc/a.txt')).toBe('hello')
    expect(await read('/tmp/zdest/zsrc/sub/b.txt')).toBe('world'.repeat(50000))
  })

  it('skips existing files without -o, overwrites with -o, and honors -x', async () => {
    expect(await kernel.shell.execute('cd /tmp && unzip -q -d /tmp/zdest z.zip')).toBe(0)
    await kernel.filesystem.fs.writeFile('/tmp/zdest/zsrc/a.txt', 'changed')
    await kernel.shell.execute('cd /tmp && unzip -q -d /tmp/zdest z.zip')
    expect(await read('/tmp/zdest/zsrc/a.txt')).toBe('changed')
    await kernel.shell.execute('cd /tmp && unzip -qo -d /tmp/zdest z.zip')
    expect(await read('/tmp/zdest/zsrc/a.txt')).toBe('hello')

    await kernel.shell.execute('cd /tmp && unzip -q -x "*.txt" -d /tmp/zexcl z.zip')
    expect(await kernel.filesystem.fs.exists('/tmp/zexcl/zsrc/a.txt')).toBe(false)
  })

  it('reports errors with a nonzero exit code', async () => {
    expect(await kernel.shell.execute('cd /tmp && unzip nope.zip 2> /tmp/e1.out')).toBe(1)
    expect(await read('/tmp/e1.out')).toContain('No such file or directory')
    expect(await kernel.shell.execute('cd /tmp && zip only.zip 2> /tmp/e2.out')).toBe(1)
    expect(await read('/tmp/e2.out')).toContain('nothing to do')
    expect(await kernel.shell.execute('cd /tmp && zip only.zip zsrc 2> /tmp/e3.out')).toBe(1)
    expect(await read('/tmp/e3.out')).toContain('Use -r')
  })
})
