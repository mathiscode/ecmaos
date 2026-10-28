import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * wget (a program's fetch is its worker's, so only what it cannot reach is tried here), and rsync, the real
 * one built for WALI, locally and through a remote shell; and the kernel calls they needed: fchdir, open with
 * O_DIRECTORY of a file failing with ENOTDIR, and setting the times of a directory and of a symbolic link.
 */
describe('wget and rsync', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_ALL })
    await kernel.boot()
    await kernel.whenProgramsReady()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 120_000)

  it('wget reports what it cannot reach, and refuses what is not a URL it can fetch', async () => {
    // a program's fetch is the worker's own; nothing listens on port 1
    const refused = await run('wget http://127.0.0.1:1/file')
    expect(refused.code).toBe(4)
    expect(refused.err).toContain('Connecting to 127.0.0.1:1... failed')
    expect((await run('wget ftp://example.com/x')).err).toContain('Unsupported scheme ftp:.')
    expect((await run('wget')).err).toContain('wget: missing URL')
    expect((await run('wget --version')).out).toMatch(/^GNU Wget/)
  }, 30_000)

  it('rsync copies a tree with its times, modes and links, and deletes what is gone', async () => {
    await kernel.shell.execute('mkdir -p /tmp/src/sub; echo one > /tmp/src/a; echo two > /tmp/src/sub/b; ln -s a /tmp/src/link; chmod 750 /tmp/src/sub; touch -d "2020-01-02 03:04:05" /tmp/src/a /tmp/src/sub')
    const copy = await run('rsync -a /tmp/src/ /tmp/dst/')
    expect(copy.err).toBe('')
    expect(copy.code).toBe(0)
    expect(await read('/tmp/dst/sub/b')).toBe('two\n')
    expect(await fs().readlink('/tmp/dst/link')).toBe('a')
    const sub = await fs().stat('/tmp/dst/sub')
    expect(sub.mode & 0o777).toBe(0o750)
    expect(new Date(sub.mtimeMs).getFullYear()).toBe(2020)
    expect(new Date((await fs().stat('/tmp/dst/a')).mtimeMs).getFullYear()).toBe(2020)
    expect((await run('rsync -ai /tmp/src/ /tmp/dst/')).out).toBe('')
    await kernel.shell.execute('rm /tmp/src/sub/b; echo changed > /tmp/src/a')
    const update = await run('rsync -av --delete /tmp/src/ /tmp/dst/')
    expect(update.out).toContain('deleting sub/b')
    expect(await read('/tmp/dst/a')).toBe('changed\n')
  }, 60_000)

  it('rsync pushes and pulls through a remote shell, as it does over ssh', async () => {
    await fs().writeFile('/tmp/rsh', '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 })
    expect((await run('rsync -az -e /tmp/rsh /tmp/src/ elsewhere:/tmp/remote/')).code).toBe(0)
    expect(await read('/tmp/remote/a')).toBe('changed\n')
    expect((await run('rsync -a -e /tmp/rsh elsewhere:/tmp/remote/ /tmp/pulled/')).code).toBe(0)
    expect(await fs().readlink('/tmp/pulled/link')).toBe('a')
  }, 60_000)

  it('touch sets a directory\'s times, and open with O_DIRECTORY of a file is ENOTDIR', async () => {
    await fs().mkdir('/tmp/timed', { recursive: true })
    expect((await run('touch -d "2021-05-06 07:08:09" /tmp/timed')).code).toBe(0)
    expect(new Date((await fs().stat('/tmp/timed')).mtimeMs).getFullYear()).toBe(2021)
    await fs().writeFile('/tmp/plain', 'x')
    const opened = await run(`python3 -c "import os; os.open('/tmp/plain', os.O_RDONLY | os.O_DIRECTORY)"`)
    expect(opened.code).toBe(1)
    expect(opened.err).toContain('NotADirectoryError')
  }, 30_000)
})
