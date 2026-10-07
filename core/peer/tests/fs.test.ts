import { describe, expect, it } from 'vitest'
import { cleanPath, Connection, FsClient, FsError, MaxRead, memoryPair, MessageStream, serveFs } from '../src/index.ts'
import type { ExportFs, FsStat, FsTouch } from '../src/index.ts'

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

/** A small in-memory export, with a log of what reached it */
function memoryExport() {
  type Node = { dir: true } | { dir: false, data: Uint8Array, mode: number }
  const nodes = new Map<string, Node>([['/', { dir: true }]])
  const log: string[] = []
  const stat = (path: string): FsStat => {
    const node = nodes.get(path)
    if (!node) throw new FsError('ENOENT', `no such file: ${path}`)
    return { mode: node.dir ? S_IFDIR | 0o755 : S_IFREG | node.mode, size: node.dir ? 0 : node.data.length, uid: 1, gid: 1, atimeMs: 1, mtimeMs: 2, ctimeMs: 3, birthtimeMs: 4, ino: 5, nlink: 1 }
  }
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
  const backend: ExportFs = {
    async stat(path) { log.push(`stat ${path}`); return stat(path) },
    async readdir(path) {
      log.push(`readdir ${path}`)
      if (!nodes.get(path)?.dir) throw new FsError('ENOTDIR')
      return [...nodes.keys()].filter(key => key !== path && parent(key) === path).map(key => key.slice(key.lastIndexOf('/') + 1))
    },
    async read(path, start, end) {
      log.push(`read ${path} ${start} ${end}`)
      const node = nodes.get(path)
      if (!node) throw new FsError('ENOENT')
      if (node.dir) throw new FsError('EISDIR')
      return node.data.slice(start, end)
    },
    async write(path, offset, data) {
      log.push(`write ${path} ${offset} ${data.length}`)
      const node = nodes.get(path)
      if (!node || node.dir) throw new FsError('ENOENT')
      const next = new Uint8Array(Math.max(node.data.length, offset + data.length))
      next.set(node.data); next.set(data, offset)
      node.data = next
    },
    async create(path, mode) {
      log.push(`create ${path}`)
      if (nodes.has(path)) throw new FsError('EEXIST')
      nodes.set(path, { dir: false, data: new Uint8Array(0), mode })
      return stat(path)
    },
    async mkdir(path) {
      log.push(`mkdir ${path}`)
      if (nodes.has(path)) throw new FsError('EEXIST')
      nodes.set(path, { dir: true })
      return stat(path)
    },
    async unlink(path) { log.push(`unlink ${path}`); if (!nodes.delete(path)) throw new FsError('ENOENT') },
    async rmdir(path) { log.push(`rmdir ${path}`); if (!nodes.delete(path)) throw new FsError('ENOENT') },
    async rename(from, to) { log.push(`rename ${from} ${to}`); const node = nodes.get(from); if (!node) throw new FsError('ENOENT'); nodes.set(to, node); nodes.delete(from) },
    async link() { throw new FsError('EPERM') },
    async touch(path, change: FsTouch) {
      log.push(`touch ${path} ${JSON.stringify(change)}`)
      const node = nodes.get(path)
      if (!node) throw new FsError('ENOENT')
      if (!node.dir && change.size !== undefined) node.data = node.data.slice(0, change.size)
    },
    async summary(limits) { return { files: nodes.size - 1, bytes: 0, exceeded: nodes.size - 1 > limits.files } }
  }
  return { backend, log, nodes }
}

async function setup(options: { readOnly?: boolean } = {}, backend = memoryExport()) {
  const [a, b] = memoryPair()
  const client = new Connection(a, { role: 'client' })
  const server = new Connection(b, { role: 'server' })
  const errors: unknown[] = []
  server.accept('fs', channel => { serveFs(new MessageStream(channel), backend.backend, { ...options, onError: (_op, _path, error) => errors.push(error) }) })
  const channel = await client.open('fs')
  return { fs: new FsClient(new MessageStream(channel), 2000), backend, client, server, errors }
}

describe('cleanPath', () => {
  it('normalises, and refuses anything that could leave the root', () => {
    expect(cleanPath('/')).toBe('/')
    expect(cleanPath('//a///b/./c/')).toBe('/a/b/c')
    for (const bad of ['a/b', '', '/a/../b', '/..', '/a/b/..', '/a\0b', 5, null, undefined, '/' + 'x'.repeat(5000)]) expect(cleanPath(bad)).toBeUndefined()
  })
})

describe('filesystem protocol', () => {
  it('stats, lists, creates, writes, reads, renames and removes', async () => {
    const { fs } = await setup()
    expect(await fs.call('stat', '/')).toMatchObject({ mode: S_IFDIR | 0o755 })
    expect(await fs.call('mkdir', '/dir', 0o755)).toMatchObject({ mode: S_IFDIR | 0o755 })
    expect(await fs.call('create', '/dir/a.txt', 0o644)).toMatchObject({ size: 0 })
    await fs.call('write', '/dir/a.txt', 0, new TextEncoder().encode('hello world'))
    expect(await fs.call('readdir', '/dir')).toEqual(['a.txt'])
    expect(new TextDecoder().decode(await fs.call('read', '/dir/a.txt', 6, 11) as Uint8Array)).toBe('world')
    await fs.call('rename', '/dir/a.txt', '/dir/b.txt')
    await fs.call('touch', '/dir/b.txt', { size: 5 })
    expect(await fs.call('stat', '/dir/b.txt')).toMatchObject({ size: 5 })
    await fs.call('unlink', '/dir/b.txt')
    await fs.call('rmdir', '/dir')
    expect(await fs.call('readdir', '/')).toEqual([])
  })

  it('error codes survive, and the far side gets the code and no host detail it did not choose', async () => {
    const { fs, backend } = await setup()
    await expect(fs.call('stat', '/missing')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.call('mkdir', '/', 0o755)).rejects.toMatchObject({ code: 'EEXIST' })
    // an error the backend raised on its own, with a message naming a host path
    backend.backend.stat = async () => { throw Object.assign(new Error("EACCES: permission denied, stat '/srv/secret/x'"), { code: 'EACCES' }) }
    const error = await fs.call('stat', '/x').catch(error => error)
    expect(error).toMatchObject({ code: 'EACCES', message: 'EACCES' })
  })

  it('moves a file larger than a message and larger than a read, in order', async () => {
    const { fs } = await setup()
    await fs.call('create', '/big', 0o644)
    const data = Uint8Array.from({ length: 8 << 20 }, (_, index) => (index * 31) % 251)
    for (let offset = 0; offset < data.length; offset += MaxRead) await fs.call('write', '/big', offset, data.subarray(offset, offset + MaxRead))
    const back = new Uint8Array(data.length)
    for (let offset = 0; offset < data.length; offset += MaxRead) back.set(await fs.call('read', '/big', offset, offset + MaxRead) as Uint8Array, offset)
    expect(Buffer.compare(back, data)).toBe(0)
  })

  it('refuses bad requests before the backend sees them', async () => {
    const { fs, backend } = await setup()
    for (const call of [
      () => fs.call('stat', '/a/../etc'), () => fs.call('stat', 'relative'), () => fs.call('read', '/x', 5, 2),
      () => fs.call('read', '/x', 0, MaxRead + 1), () => fs.call('write', '/x', 0, 'not bytes'), () => fs.call('write', '/x', -1, new Uint8Array(1)),
      () => fs.call('constructor'), () => fs.call('__proto__'), () => fs.call('ready'), () => fs.call('touch', '/x', { size: 'big' })
    ]) await expect(call()).rejects.toBeInstanceOf(FsError)
    expect(backend.log).toEqual([])
  })

  it('a read-only export refuses every change with EROFS and still answers reads', async () => {
    const { fs, backend } = await setup({ readOnly: true })
    backend.nodes.set('/f', { dir: false, data: new Uint8Array([1, 2, 3]), mode: 0o644 })
    for (const call of [
      () => fs.call('write', '/f', 0, new Uint8Array(1)), () => fs.call('create', '/g', 0o644), () => fs.call('mkdir', '/d', 0o755), () => fs.call('unlink', '/f'),
      () => fs.call('rmdir', '/f'), () => fs.call('rename', '/f', '/h'), () => fs.call('link', '/f', '/h'), () => fs.call('touch', '/f', { mode: 0o777 })
    ]) await expect(call()).rejects.toMatchObject({ code: 'EROFS' })
    expect(await fs.call('read', '/f', 0, 3)).toEqual(new Uint8Array([1, 2, 3]))
    expect(backend.log).toEqual(['read /f 0 3'])
  })

  it('carries out requests in the order they were made, however they are sent', async () => {
    const { fs, backend } = await setup()
    await fs.call('create', '/o', 0o644)
    await Promise.all([fs.call('write', '/o', 0, new Uint8Array(10)), fs.call('touch', '/o', { size: 3 }), fs.call('write', '/o', 0, new Uint8Array(1)), fs.call('stat', '/o')])
    expect(backend.log.slice(1)).toEqual(['write /o 0 10', 'touch /o {"size":3}', 'write /o 0 1', 'stat /o'])
  })

  it('reports the summary a mount uses to refuse a tree that is too big', async () => {
    const { fs, backend } = await setup()
    for (let index = 0; index < 5; index++) backend.nodes.set(`/f${index}`, { dir: false, data: new Uint8Array(1), mode: 0o644 })
    expect(await fs.call('summary', 10, 1000)).toMatchObject({ files: 5, exceeded: false })
    expect(await fs.call('summary', 3, 1000)).toMatchObject({ exceeded: true })
  })

  it('fails calls that were waiting, and later ones, when the connection ends', async () => {
    const { fs, backend, client } = await setup()
    backend.backend.stat = () => new Promise(() => {})
    const waiting = fs.call('stat', '/never')
    await new Promise(resolve => setTimeout(resolve, 20))
    client.close()
    await expect(waiting).rejects.toMatchObject({ code: 'ENOTCONN' })
    await expect(fs.call('stat', '/')).rejects.toMatchObject({ code: 'ENOTCONN' })
  })

  it('times out a call the other side never answers', async () => {
    const { fs, backend } = await setup()
    backend.backend.stat = () => new Promise(() => {})
    await expect(fs.call('stat', '/x')).rejects.toMatchObject({ code: 'ETIMEDOUT' })
  })
})
