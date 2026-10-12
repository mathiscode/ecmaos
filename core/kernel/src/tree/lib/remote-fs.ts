import { Async, FileSystem, InMemory, Inode } from '@zenfs/core'
import type { CreationOptions, InodeLike } from '@zenfs/core'
import { Errno, withErrno } from 'kerium'
import { FsError, MaxRead } from '@ecmaos/peer'
import type { FsClient, FsStat, Value } from '@ecmaos/peer'

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

export interface RemoteFsOptions {
  /**
   * A tree larger than either is refused when the mount is made (it is copied to this machine's memory, see below)
   */
  limits: { files: number, bytes: number }
  /** Who the files appear to belong to here; the other machine's own owners mean nothing on this one */
  owner: { uid: number, gid: number }
  /** Something the other machine refused or could not do, for a change that had already been accepted here */
  onError?: (operation: string, path: string, error: unknown) => void
}

/** The part of a ZenFS error code `FsError` carries over the wire that this machine knows, else `EIO` */
function errnoOf(code: string): keyof typeof Errno {
  return typeof (Errno as unknown as Record<string, unknown>)[code] === 'number' && Number.isNaN(Number(code)) ? code as keyof typeof Errno : 'EIO'
}

function failure(error: unknown): never {
  if (error instanceof FsError) {
    const code = errnoOf(error.code)
    throw withErrno(code, error.message === error.code ? undefined : error.message)
  }
  throw error
}

/**
 * Another ecmaOS machine's directory, mounted here. The synchronous file API is served from an in-memory copy of the
 * remote tree (`Async` copies it when the mount is made and sends changes on in the background), so a tree past
 * `limits` is refused, changes made on the other machine are not seen until remounted, and a change refused over
 * there is reported through `onError`. The asynchronous API (`fs.promises`) reaches the other machine.
 */
export class RemoteFS extends Async(FileSystem) {
  /** @hidden */
  _sync = InMemory.create({ label: 'tmpfs:remote' })
  private _checked = false
  /** Set by the mount once the link is made; closing it ends the mount's use of the connection */
  closeRemote: (() => void) | undefined

  constructor(readonly client: FsClient, readonly options: RemoteFsOptions) {
    super(0x65636d6f, 'ecmaosfs')
  }

  /** Whether the connection to the other machine is still up */
  get connected() { return !this.client.closed }

  private async call(op: string, ...args: Value[]) {
    try {
      return await this.client.call(op, ...args)
    } catch (error) {
      return failure(error)
    }
  }

  private inode(value: unknown): Inode {
    const stat = value as FsStat
    return new Inode({
      mode: stat.mode, size: stat.size, uid: this.options.owner.uid, gid: this.options.owner.gid,
      atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs, ino: stat.ino, nlink: stat.nlink
    })
  }

  /**
   * A change the synchronous API already applied locally is sent in the background; if it fails, nobody is waiting to
   * be
   * told, so it is reported here instead of becoming an unhandled rejection (which ends a Node process).
   * @internal
   */
  _async(thunk: () => Promise<unknown>) {
    const self = this as unknown as { _promise: Promise<unknown> }
    self._promise = self._promise.then(() => thunk()).catch(error => {
      const code = error instanceof Error ? error.message : String(error)
      this.options.onError?.('background change', '', code)
    })
  }

  override async ready() {
    if (!this._checked) {
      const summary = await this.call('summary', this.options.limits.files, this.options.limits.bytes) as { files: number, bytes: number, exceeded: boolean }
      if (summary.exceeded) {
        throw withErrno('EFBIG', `the directory is larger than ${this.options.limits.files} files or ${Math.round(this.options.limits.bytes / 1048576)} MB; it would be copied into memory`)
      }
      this._checked = true
    }
    await super.ready()
  }

  async stat(path: string) { return this.inode(await this.call('stat', path)) }

  async exists(path: string) {
    try { await this.call('stat', path); return true } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false
      throw error
    }
  }

  async readdir(path: string) { return await this.call('readdir', path) as string[] }

  async read(path: string, buffer: Uint8Array, start: number, end: number) {
    for (let at = start; at < end; at += MaxRead) {
      const chunk = await this.call('read', path, at, Math.min(at + MaxRead, end)) as Uint8Array
      buffer.set(chunk, at - start)
      if (chunk.length < Math.min(MaxRead, end - at)) break
    }
  }

  async write(path: string, buffer: Uint8Array, offset: number) {
    try {
      for (let at = 0; at < buffer.length; at += MaxRead) await this.call('write', path, offset + at, buffer.subarray(at, at + MaxRead))
    } catch (error) {
      this.options.onError?.('write', path, error)
      throw error
    }
  }

  async createFile(path: string, options: CreationOptions) {
    // The mode may or may not carry the file type; one that names another type (a symbolic link, a device) cannot be
    // made here
    if ((options.mode & S_IFMT) && (options.mode & S_IFMT) !== S_IFREG) throw withErrno('EPERM', 'only regular files can be created on a remote mount')
    return this.inode(await this.call('create', path, options.mode & 0o7777))
  }

  async mkdir(path: string, options: CreationOptions) {
    if ((options.mode & S_IFMT) && (options.mode & S_IFMT) !== S_IFDIR) throw withErrno('EPERM', 'only directories can be created here')
    return this.inode(await this.call('mkdir', path, options.mode & 0o7777))
  }

  async unlink(path: string) { await this.call('unlink', path) }
  async rmdir(path: string) { await this.call('rmdir', path) }
  async rename(from: string, to: string) { await this.call('rename', from, to) }
  async link(from: string, to: string) { await this.call('link', from, to) }

  async touch(path: string, metadata: InodeLike | Inode) {
    // Only what the caller actually set: a change of times alone arrives with no mode, and that is not a request for
    // mode 0
    const change: { [key: string]: number } = {}
    if (typeof metadata.mode === 'number') change['mode'] = metadata.mode & 0o7777
    if (typeof metadata.atimeMs === 'number') change['atimeMs'] = metadata.atimeMs
    if (typeof metadata.mtimeMs === 'number') change['mtimeMs'] = metadata.mtimeMs
    if (typeof metadata.size === 'number') change['size'] = metadata.size
    await this.call('touch', path, change)
  }
}
