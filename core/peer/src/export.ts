import { FsError } from './fs.ts'
import type { ExportFs, FsStat, FsSummary, FsTouch } from './fs.ts'

/** The part of a `Stats` the export reads (Node's and ZenFS's both fit) */
export interface StatsLike {
  mode: number | bigint
  size: number | bigint
  uid: number | bigint
  gid: number | bigint
  atimeMs: number | bigint
  mtimeMs: number | bigint
  ctimeMs: number | bigint
  birthtimeMs: number | bigint
  ino: number | bigint
  nlink: number | bigint
}

export interface HandleLike {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>
  close(): Promise<void>
}

/** The part of `fs.promises` the export uses, so it can serve the real filesystem on Node and the virtual one in a browser alike */
export interface PromisesLike {
  lstat(path: string): Promise<StatsLike>
  readdir(path: string): Promise<string[]>
  readlink(path: string): Promise<string>
  open(path: string, flags: string, mode?: number): Promise<HandleLike>
  mkdir(path: string, options?: { mode?: number }): Promise<unknown>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  link(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  utimes(path: string, atime: Date, mtime: Date): Promise<void>
  truncate(path: string, length: number): Promise<void>
}

export interface PromisesExportOptions {
  /** The directory the export is rooted at, in `fs`'s own path syntax (no trailing slash; `''` for the root of a virtual filesystem) */
  root: string
  /**
   * Called with every full path before it is used. A backend on a real filesystem uses it to refuse anything that reaches
   * outside the root through a symbolic link; it throws (`EACCES`) to refuse.
   */
  confine?: (full: string, path: string) => Promise<void>
}

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

const num = (value: number | bigint) => Number(value)

function toStat(stats: StatsLike): FsStat {
  return {
    mode: num(stats.mode), size: num(stats.size), uid: num(stats.uid), gid: num(stats.gid),
    atimeMs: num(stats.atimeMs), mtimeMs: num(stats.mtimeMs), ctimeMs: num(stats.ctimeMs), birthtimeMs: num(stats.birthtimeMs),
    ino: num(stats.ino) % 0x1_0000_0000, nlink: num(stats.nlink)
  }
}

/** An export of the tree under `root` in a `fs.promises`-shaped filesystem */
export class PromisesExport implements ExportFs {
  constructor(private readonly _fs: PromisesLike, private readonly _options: PromisesExportOptions) {}

  private async _full(path: string): Promise<string> {
    const full = this._options.root + (path === '/' ? '' : path) || '/'
    await this._options.confine?.(full, path)
    return full
  }

  async stat(path: string) { return toStat(await this._fs.lstat(await this._full(path))) }

  async readdir(path: string) {
    const full = await this._full(path)
    // A link is not followed: listing it would list wherever it points, which may be outside the root
    if ((num((await this._fs.lstat(full)).mode) & S_IFMT) === S_IFLNK) throw new FsError('ENOTDIR')
    return await this._fs.readdir(full)
  }

  async read(path: string, start: number, end: number): Promise<Uint8Array> {
    const full = await this._full(path)
    const stats = await this._fs.lstat(full)
    const kind = num(stats.mode) & S_IFMT
    if (kind === S_IFLNK) return new TextEncoder().encode(await this._fs.readlink(full)).slice(start, end)
    if (kind === S_IFDIR) throw new FsError('EISDIR')
    const buffer = new Uint8Array(Math.max(0, Math.min(end, num(stats.size)) - start))
    if (buffer.length === 0) return buffer
    const handle = await this._fs.open(full, 'r')
    try {
      let done = 0
      while (done < buffer.length) {
        const { bytesRead } = await handle.read(buffer, done, buffer.length - done, start + done)
        if (bytesRead === 0) break
        done += bytesRead
      }
      return done === buffer.length ? buffer : buffer.slice(0, done)
    } finally { await handle.close() }
  }

  async write(path: string, offset: number, data: Uint8Array) {
    const full = await this._full(path)
    if ((num((await this._fs.lstat(full)).mode) & S_IFMT) !== S_IFREG) throw new FsError('EINVAL', 'not a regular file')
    const handle = await this._fs.open(full, 'r+')
    try {
      let done = 0
      while (done < data.length) {
        const { bytesWritten } = await handle.write(data, done, data.length - done, offset + done)
        if (bytesWritten <= 0) throw new FsError('EIO', 'short write')
        done += bytesWritten
      }
    } finally { await handle.close() }
  }

  async create(path: string, mode: number) {
    const full = await this._full(path)
    // 'wx' fails if the name exists, symbolic links included
    const handle = await this._fs.open(full, 'wx', mode & 0o7777)
    await handle.close()
    return toStat(await this._fs.lstat(full))
  }

  async mkdir(path: string, mode: number) {
    const full = await this._full(path)
    await this._fs.mkdir(full, { mode: mode & 0o7777 })
    return toStat(await this._fs.lstat(full))
  }

  async unlink(path: string) { await this._fs.unlink(await this._full(path)) }
  async rmdir(path: string) { await this._fs.rmdir(await this._full(path)) }
  async rename(from: string, to: string) { await this._fs.rename(await this._full(from), await this._full(to)) }
  async link(from: string, to: string) { await this._fs.link(await this._full(from), await this._full(to)) }

  async touch(path: string, change: FsTouch) {
    const full = await this._full(path)
    const stats = await this._fs.lstat(full)
    const kind = num(stats.mode) & S_IFMT
    const link = kind === S_IFLNK
    if (change.mode !== undefined && !link) await this._fs.chmod(full, change.mode & 0o7777)
    // The size of a directory is whatever the filesystem says; only a file is cut or extended
    if (change.size !== undefined && kind === S_IFREG && change.size !== num(stats.size)) await this._fs.truncate(full, change.size)
    if ((change.atimeMs !== undefined || change.mtimeMs !== undefined) && !link) {
      await this._fs.utimes(full, new Date(change.atimeMs ?? num(stats.atimeMs)), new Date(change.mtimeMs ?? num(stats.mtimeMs)))
    }
  }

  async summary(limits: { files: number, bytes: number }): Promise<FsSummary> {
    let files = 0
    let bytes = 0
    const walk = async (path: string): Promise<boolean> => {
      for (const name of await this.readdir(path)) {
        const child = path === '/' ? `/${name}` : `${path}/${name}`
        const stats = await this._fs.lstat(await this._full(child))
        files++
        const kind = num(stats.mode) & S_IFMT
        if (kind === S_IFREG) bytes += num(stats.size)
        if (files > limits.files || bytes > limits.bytes) return false
        if (kind === S_IFDIR && !await walk(child)) return false
      }
      return true
    }
    const complete = await walk('/')
    return { files, bytes, exceeded: !complete }
  }
}
