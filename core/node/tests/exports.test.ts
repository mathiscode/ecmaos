import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Connection, FsClient, memoryPair, MessageStream, serveFs } from '@ecmaos/peer'

import { openExport, parseExport } from '../src/exports.ts'

const folders: string[] = []
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'ecmaos-export-')); folders.push(dir); return dir }
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

/** An export of a fresh folder with a secret next to it, served and reached through the protocol */
async function setup(readOnly = false) {
  const outer = temp()
  const dir = path.join(outer, 'share')
  mkdirSync(dir)
  writeFileSync(path.join(outer, 'secret.txt'), 'top secret')
  mkdirSync(path.join(outer, 'secretdir'))
  writeFileSync(path.join(outer, 'secretdir', 'inner.txt'), 'inner')
  writeFileSync(path.join(dir, 'hello.txt'), 'hello')
  mkdirSync(path.join(dir, 'sub'))
  const backend = await openExport({ name: 'share', dir, readOnly })
  const [a, b] = memoryPair()
  const client = new Connection(a, { role: 'client' })
  const server = new Connection(b, { role: 'server' })
  server.accept('fs', channel => { serveFs(new MessageStream(channel), backend, { readOnly }) })
  const fs = new FsClient(new MessageStream(await client.open('fs')), 5000)
  return { fs, dir, outer, backend }
}

describe('parseExport', () => {
  it('reads NAME=DIR, DIR and the :rw suffix; read-only by default', () => {
    expect(parseExport('share=/srv/data')).toMatchObject({ name: 'share', dir: '/srv/data', readOnly: true })
    expect(parseExport('share=/srv/data:rw')).toMatchObject({ readOnly: false })
    expect(parseExport('share=/srv/data:ro')).toMatchObject({ readOnly: true })
    expect(parseExport('/srv/data:rw')).toMatchObject({ name: 'data', dir: '/srv/data', readOnly: false })
    expect(() => parseExport('bad name=/srv')).toThrow(/may only hold/)
  })
})

describe('a host directory as an export', () => {
  it('lists, reads, writes, creates, renames and removes inside the directory, and the host sees it', async () => {
    const { fs, dir } = await setup()
    expect(await fs.call('readdir', '/')).toEqual(expect.arrayContaining(['hello.txt', 'sub']))
    expect(await fs.call('stat', '/hello.txt')).toMatchObject({ size: 5 })
    expect(new TextDecoder().decode(await fs.call('read', '/hello.txt', 1, 4) as Uint8Array)).toBe('ell')
    await fs.call('create', '/sub/new.txt', 0o640)
    await fs.call('write', '/sub/new.txt', 0, new TextEncoder().encode('written remotely'))
    expect(readFileSync(path.join(dir, 'sub', 'new.txt'), 'utf8')).toBe('written remotely')
    expect(statSync(path.join(dir, 'sub', 'new.txt')).mode & 0o777).toBe(0o640 & ~process.umask())
    await fs.call('touch', '/sub/new.txt', { size: 7, mode: 0o600 })
    expect(readFileSync(path.join(dir, 'sub', 'new.txt'), 'utf8')).toBe('written')
    expect(statSync(path.join(dir, 'sub', 'new.txt')).mode & 0o777).toBe(0o600)
    await fs.call('rename', '/sub/new.txt', '/moved.txt')
    await fs.call('mkdir', '/made', 0o755)
    await fs.call('unlink', '/moved.txt')
    await fs.call('rmdir', '/made')
    expect(await fs.call('readdir', '/')).not.toContain('moved.txt')
  })

  it('error codes are the host\'s own, and say nothing of the host path', async () => {
    const { fs, dir } = await setup()
    await expect(fs.call('stat', '/nothing')).rejects.toMatchObject({ code: 'ENOENT', message: 'ENOENT' })
    await expect(fs.call('mkdir', '/sub', 0o755)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(fs.call('rmdir', '/hello.txt')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(fs.call('create', '/hello.txt', 0o644)).rejects.toMatchObject({ code: 'EEXIST' })
    writeFileSync(path.join(dir, 'sub', 'full.txt'), 'x')
    await expect(fs.call('rmdir', '/sub')).rejects.toMatchObject({ code: 'ENOTEMPTY' })
  })

  it('round trips an 8 MB file byte for byte', async () => {
    const { fs, dir } = await setup()
    const data = Uint8Array.from({ length: 8 << 20 }, (_, index) => (index * 17 + (index >> 8)) % 256)
    await fs.call('create', '/big.bin', 0o644)
    const piece = 4 << 20
    for (let offset = 0; offset < data.length; offset += piece) await fs.call('write', '/big.bin', offset, data.subarray(offset, offset + piece))
    expect(Buffer.compare(readFileSync(path.join(dir, 'big.bin')), data)).toBe(0)
    const back = new Uint8Array(data.length)
    for (let offset = 0; offset < data.length; offset += piece) back.set(await fs.call('read', '/big.bin', offset, offset + piece) as Uint8Array, offset)
    expect(Buffer.compare(back, data)).toBe(0)
  })

  it('does not follow a symbolic link out of the directory, in any operation', async () => {
    const { fs, dir, outer } = await setup()
    symlinkSync(path.join(outer, 'secret.txt'), path.join(dir, 'link-to-file'))
    symlinkSync(path.join(outer, 'secretdir'), path.join(dir, 'link-to-dir'))
    symlinkSync('../secret.txt', path.join(dir, 'relative-link'))

    // a link is reported as a link and reads as its target text; the file behind it is out of reach
    expect(((await fs.call('stat', '/link-to-file')) as { mode: number }).mode & 0o170000).toBe(0o120000)
    expect(new TextDecoder().decode(await fs.call('read', '/link-to-file', 0, 4096) as Uint8Array)).toBe(path.join(outer, 'secret.txt'))
    await expect(fs.call('readdir', '/link-to-dir')).rejects.toMatchObject({ code: 'ENOTDIR' })
    // going through the link as a directory on the way to something
    for (const call of [
      () => fs.call('stat', '/link-to-dir/inner.txt'), () => fs.call('read', '/link-to-dir/inner.txt', 0, 5), () => fs.call('write', '/link-to-dir/inner.txt', 0, new Uint8Array(1)),
      () => fs.call('create', '/link-to-dir/new.txt', 0o644), () => fs.call('mkdir', '/link-to-dir/d', 0o755), () => fs.call('unlink', '/link-to-dir/inner.txt'),
      () => fs.call('rename', '/hello.txt', '/link-to-dir/hello.txt'), () => fs.call('rename', '/link-to-dir/inner.txt', '/x'), () => fs.call('touch', '/link-to-dir/inner.txt', { mode: 0o777 })
    ]) await expect(call()).rejects.toMatchObject({ code: 'EACCES' })
    // a write or a touch aimed at the link itself changes nothing behind it
    await expect(fs.call('write', '/link-to-file', 0, new TextEncoder().encode('overwritten'))).rejects.toMatchObject({ code: 'EINVAL' })
    await fs.call('touch', '/link-to-file', { mode: 0o777, size: 0 })
    expect(readFileSync(path.join(outer, 'secret.txt'), 'utf8')).toBe('top secret')
    expect(statSync(path.join(outer, 'secret.txt')).mode & 0o777).not.toBe(0o777)
    expect(readFileSync(path.join(outer, 'secretdir', 'inner.txt'), 'utf8')).toBe('inner')
    // creating over a name that is a link fails instead of writing through it
    await expect(fs.call('create', '/link-to-file', 0o644)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(path.join(outer, 'secret.txt'), 'utf8')).toBe('top secret')
  })

  it('cannot name anything above the directory', async () => {
    const { fs } = await setup()
    for (const bad of ['/../secret.txt', '/sub/../../secret.txt', '..', '/..', '/sub/..']) await expect(fs.call('stat', bad)).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('a read-only export changes nothing, and the host file stays as it was', async () => {
    const { fs, dir } = await setup(true)
    await expect(fs.call('write', '/hello.txt', 0, new TextEncoder().encode('x'))).rejects.toMatchObject({ code: 'EROFS' })
    await expect(fs.call('unlink', '/hello.txt')).rejects.toMatchObject({ code: 'EROFS' })
    expect(readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('hello')
    expect(new TextDecoder().decode(await fs.call('read', '/hello.txt', 0, 5) as Uint8Array)).toBe('hello')
  })

  it('counts the tree for a mount to check, and stops counting at the limit', async () => {
    const { fs, dir } = await setup()
    for (let index = 0; index < 20; index++) writeFileSync(path.join(dir, 'sub', `f${index}`), 'x'.repeat(100))
    expect(await fs.call('summary', 1000, 1 << 20)).toMatchObject({ files: 22, bytes: 2005, exceeded: false })
    expect(await fs.call('summary', 5, 1 << 20)).toMatchObject({ exceeded: true })
    expect(await fs.call('summary', 1000, 500)).toMatchObject({ exceeded: true })
  })

  it('refuses an export that is not a directory', async () => {
    const dir = temp()
    writeFileSync(path.join(dir, 'file'), 'x')
    await expect(openExport({ name: 'f', dir: path.join(dir, 'file'), readOnly: true })).rejects.toThrow(/not a directory/)
    await expect(openExport({ name: 'f', dir: path.join(dir, 'missing'), readOnly: true })).rejects.toThrow()
  })
})
