/**
 * A filesystem a WebAssembly module provides (the `filesystem` export of the `filesystem-module` world), as a ZenFS filesystem.
 * The module's calls may be asynchronous (every export of a WASI 0.3 component is), so this is an `Async(FileSystem)`: ZenFS
 * answers the calls that cannot wait from a copy of the tree in memory and passes each change on to the module.
 */

import { Async, Attributes, FileSystem, InMemory, Inode } from '@zenfs/core'
import { S_IFDIR, S_IFREG } from '@zenfs/core/constants'
import { withErrno } from 'kerium'

/** The record `inode` of the world, as jco gives it */
export interface WasmInode {
  mode: number
  size: bigint
  nlink: number
  uid: number
  gid: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
}

/** The `filesystem` export of the module, as jco gives it: a failure is thrown (or the promise rejected) with the error number as `payload` */
export interface WasmFilesystemExports {
  mount(source: string, options: Array<[string, string]>): unknown
  stat(path: string): WasmInode | Promise<WasmInode>
  readdir(path: string): string[] | Promise<string[]>
  read(path: string, offset: bigint, length: bigint): Uint8Array | Promise<Uint8Array>
  write(path: string, offset: bigint, data: Uint8Array): unknown
  create(path: string, mode: number, uid: number, gid: number, directory: boolean): unknown
  unlink(path: string): unknown
  rmdir(path: string): unknown
  rename(from: string, to: string): unknown
  link(target: string, linkPath: string): unknown
  getAttributes(path: string): Array<[string, Uint8Array]> | Promise<Array<[string, Uint8Array]>>
  setAttributes(path: string, attributes: Array<[string, Uint8Array]>): unknown
  touch(path: string, mode: number | undefined, uid: number | undefined, gid: number | undefined, size: bigint | undefined, mtimeMs: number | undefined, atimeMs: number | undefined): unknown
}

const CODES: Record<number, string> = { 1: 'EPERM', 2: 'ENOENT', 5: 'EIO', 13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 21: 'EISDIR', 22: 'EINVAL', 28: 'ENOSPC', 38: 'ENOSYS', 39: 'ENOTEMPTY' }

/** The error ZenFS expects for the number a module returned */
const errno = (error: unknown) => {
  const payload = (error as { payload?: unknown } | undefined)?.payload
  if (typeof payload === 'number') return withErrno((CODES[payload] ?? 'EIO') as 'EIO', CODES[payload] ? undefined : `error ${payload}`)
  return error
}

const inode = (stat: WasmInode, ino: number) => new Inode({
  ino,
  mode: stat.mode,
  size: Number(stat.size),
  nlink: stat.nlink,
  uid: stat.uid,
  gid: stat.gid,
  atimeMs: stat.atimeMs,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
  birthtimeMs: stat.birthtimeMs
})

export class WasmFS extends Async(FileSystem) {
  /**
   * `-o lazy` (or `lazy=true`) keeps no copy of the tree: nothing is read at mount, every call goes to the module, and the
   * synchronous calls, which need a copy, fail with ENOTSUP. For a tree too big to hold in memory, or too slow to walk.
   */
  readonly lazy: boolean
  private readonly mounted: { source: string, options: Record<string, string> }

  constructor(private readonly module: () => WasmFilesystemExports, name: string, mounted: { source: string, options: Record<string, string> }) {
    super(0x7761736d, name)
    const { lazy, ...options } = mounted.options
    this.lazy = lazy !== undefined && !['false', '0', 'no'].includes(lazy)
    // the module is not told: it sees a filesystem either way
    this.mounted = { source: mounted.source, options }
    this._sync = InMemory.create({ label: `${name}:` })
    if (this.lazy) this.attributes.set('no_async_preload', true)
  }

  /** The inode number of each path. The VFS tells open files apart by it, and a module has no such number to give. The root is 0. */
  readonly #inos = new Map<string, number>([['/', 0]])
  #next = 1

  #ino(path: string): number {
    let ino = this.#inos.get(path)
    if (ino === undefined) this.#inos.set(path, ino = this.#next++)
    return ino
  }

  /** A path and everything below it was moved or removed (`to` is where it went, if it did) */
  #moved(from: string, to?: string) {
    const below = `${from}/`
    for (const [path, ino] of [...this.#inos]) {
      if (path !== from && !path.startsWith(below)) continue
      this.#inos.delete(path)
      if (to !== undefined) this.#inos.set(to + path.slice(from.length), ino)
    }
  }

  /** Runs a call of the module and turns its failure into the error ZenFS expects */
  async #call<T>(run: (module: WasmFilesystemExports) => T | Promise<T>): Promise<T> {
    try {
      return await run(this.module())
    } catch (error) {
      throw errno(error)
    }
  }

  override async ready(): Promise<void> {
    await this.#call(module => module.mount(this.mounted.source, Object.entries(this.mounted.options)))
    await super.ready()
  }

  async stat(path: string): Promise<Inode> {
    const found = inode(await this.#call(module => module.stat(path)), this.#ino(path))
    const attributes = await this.#call(module => module.getAttributes(path))
    if (attributes.length) {
      found.attributes ??= new Attributes()
      for (const [name, value] of attributes) found.attributes.set(name, value)
    }
    return found
  }

  async readdir(path: string): Promise<string[]> {
    return await this.#call(module => module.readdir(path))
  }

  async read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void> {
    const data = await this.#call(module => module.read(path, BigInt(start), BigInt(end - start)))
    buffer.set(data.subarray(0, end - start))
  }

  async write(path: string, buffer: Uint8Array, offset: number): Promise<void> {
    await this.#call(module => module.write(path, BigInt(offset), buffer))
  }

  async createFile(path: string, options: { mode: number, uid: number, gid: number }): Promise<Inode> {
    await this.#call(module => module.create(path, options.mode & 0o7777, options.uid, options.gid, false))
    return new Inode({ ino: this.#ino(path), mode: options.mode | S_IFREG, uid: options.uid, gid: options.gid })
  }

  async mkdir(path: string, options: { mode: number, uid: number, gid: number }): Promise<Inode> {
    await this.#call(module => module.create(path, options.mode & 0o7777, options.uid, options.gid, true))
    return new Inode({ ino: this.#ino(path), mode: options.mode | S_IFDIR, uid: options.uid, gid: options.gid })
  }

  async unlink(path: string): Promise<void> {
    await this.#call(module => module.unlink(path))
    this.#moved(path)
  }

  async rmdir(path: string): Promise<void> {
    await this.#call(module => module.rmdir(path))
    this.#moved(path)
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return
    await this.#call(module => module.rename(from, to))
    this.#moved(to)
    this.#moved(from, to)
  }

  async touch(path: string, metadata: Partial<{ mode: number, uid: number, gid: number, size: number, mtimeMs: number, atimeMs: number }> = {}): Promise<void> {
    const attributes = (metadata as { attributes?: Attributes }).attributes
    // extended attributes travel on the inode ZenFS passes to touch
    if (attributes) await this.#call(module => module.setAttributes(path, [...attributes.keys()].map(name => [name, new Uint8Array(attributes.get(name)!)] as [string, Uint8Array])))
    await this.#call(module => module.touch(
      path,
      metadata.mode === undefined ? undefined : metadata.mode & 0o7777,
      metadata.uid,
      metadata.gid,
      metadata.size === undefined ? undefined : BigInt(metadata.size),
      metadata.mtimeMs,
      metadata.atimeMs
    ))
  }

  async sync(): Promise<void> { /* every call has already reached the module */ }

  /** A hard link is another path with the same inode number, which is how the VFS knows the two are one file */
  async link(target: string, link: string): Promise<void> {
    await this.#call(module => module.link(target, link))
    this.#inos.set(link, this.#ino(target))
  }
}
