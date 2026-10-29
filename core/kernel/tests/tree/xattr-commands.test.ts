import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `getfattr` and `setfattr`, over the extended attributes the VFS keeps */
describe('getfattr and setfattr', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    await fs().mkdir('/srv/x/sub', { recursive: true })
    await fs().writeFile('/srv/x/notes', 'n')
    await fs().writeFile('/srv/x/sub/deep', 'd')
  }, 60_000)

  it('sets, shows and removes an attribute', async () => {
    expect((await run('setfattr -n user.comment -v "first draft" /srv/x/notes')).code).toBe(0)
    expect((await run('setfattr -n user.empty /srv/x/notes')).code).toBe(0)
    const listed = await run('getfattr /srv/x/notes')
    expect(listed.out).toBe('# file: srv/x/notes\nuser.comment\nuser.empty\n\n')
    expect(listed.err).toBe("getfattr: Removing leading '/' from absolute path names\n")
    expect((await run('getfattr -d --absolute-names /srv/x/notes')).out).toBe('# file: /srv/x/notes\nuser.comment="first draft"\nuser.empty\n\n')
    expect((await run('getfattr -n user.comment -e hex /srv/x/notes')).out).toBe('# file: srv/x/notes\nuser.comment=0x6669727374206472616674\n\n')
    expect((await run('getfattr -n user.comment --only-values /srv/x/notes')).out).toBe('first draft')
    expect((await run('setfattr -x user.empty /srv/x/notes')).code).toBe(0)
    const missing = await run('getfattr -n user.empty /srv/x/notes')
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('srv/x/notes: user.empty: No such attribute')
  }, 60_000)

  it('reads hex, base64 and quoted values, and shows binary in base64', async () => {
    await run('setfattr -n user.bin -v 0x00ff10 /srv/x/notes')
    expect((await run('getfattr -n user.bin /srv/x/notes')).out).toContain('user.bin=0sAP8Q\n')
    await run('setfattr -n user.b64 -v 0saGk= /srv/x/notes')
    expect((await run('getfattr -n user.b64 --only-values /srv/x/notes')).out).toBe('hi')
    await run(`setfattr -n user.quoted -v '"a\\012b"' /srv/x/notes`)
    expect((await run('getfattr -n user.quoted --only-values /srv/x/notes')).out).toBe('a\nb')
    expect((await run('getfattr -n user.quoted -e text /srv/x/notes')).out).toContain('user.quoted="a\\012b"\n')
  }, 60_000)

  it('refuses names outside user., and a missing file', async () => {
    const other = await run('setfattr -n trusted.x -v 1 /srv/x/notes')
    expect(other.code).toBe(1)
    expect(other.err).toMatch(/^setfattr: \/srv\/x\/notes: /)
    const gone = await run('getfattr -d /srv/x/nothing')
    expect(gone.code).toBe(1)
    expect(gone.err).toContain('No such file or directory')
    expect((await run('setfattr /srv/x/notes')).code).toBe(1)
  }, 60_000)

  it('dumps a tree with -R and puts it back with --restore', async () => {
    await run('setfattr -n user.tag -v deep /srv/x/sub/deep')
    const dump = await run('getfattr -R -d /srv/x')
    expect(dump.out).toContain('# file: srv/x/notes\n')
    expect(dump.out).toContain('# file: srv/x/sub/deep\nuser.tag="deep"\n')
    await fs().writeFile('/tmp/attrs.dump', dump.out)
    await run('setfattr -x user.tag /srv/x/sub/deep')
    await run('setfattr -x user.comment /srv/x/notes')
    expect((await run('cd / && setfattr --restore=/tmp/attrs.dump')).code).toBe(0)
    expect((await run('getfattr -n user.tag --only-values /srv/x/sub/deep')).out).toBe('deep')
    expect((await run('getfattr -n user.comment --only-values /srv/x/notes')).out).toBe('first draft')
  }, 60_000)
})
