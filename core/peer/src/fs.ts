import type { Value } from './codec.ts'
import { PeerError } from './errors.ts'
import type { MessageStream } from './messages.ts'

/** The channel kind for a filesystem. The side that opens it asks to use the other side's export. */
export const FsChannel = 'fs'
/** The channel kind for a filesystem the opener offers: the side that accepts it mounts it. */
export const FsShareChannel = 'fs-share'

/** An error with a POSIX code (`ENOENT`, `EACCES`, ...), which is what crosses the wire so the far side can raise the same one */
export class FsError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'FsError'
  }
}

/** What `stat` says about a file. `mode` includes the file type bits (`S_IFDIR` and so on). */
export interface FsStat {
  mode: number
  size: number
  uid: number
  gid: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  ino: number
  nlink: number
}

/** The part of a file's metadata `touch` can change; whatever is absent is left as it is */
export interface FsTouch {
  mode?: number
  atimeMs?: number
  mtimeMs?: number
  /** Truncates or extends the file to this size */
  size?: number
}

export interface FsSummary {
  files: number
  bytes: number
  /** The count stopped at a limit, so the real totals are larger */
  exceeded: boolean
}

/**
 * What an export has to be: a tree of files under a root, addressed by absolute paths (`/a/b`). Paths reaching a backend are
 * already validated (absolute, normalised, no `..`), but a backend that touches a real filesystem has to confine them itself.
 * `stat` does not follow a symbolic link, and a link reads as its target text.
 */
export interface ExportFs {
  stat(path: string): Promise<FsStat>
  readdir(path: string): Promise<string[]>
  read(path: string, start: number, end: number): Promise<Uint8Array>
  write(path: string, offset: number, data: Uint8Array): Promise<void>
  /** A new regular file; `EEXIST` when there is one already */
  create(path: string, mode: number): Promise<FsStat>
  mkdir(path: string, mode: number): Promise<FsStat>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  link(from: string, to: string): Promise<void>
  touch(path: string, change: FsTouch): Promise<void>
  /** Counts what is below the root, stopping once either limit is passed */
  summary(limits: { files: number, bytes: number }): Promise<FsSummary>
}

/** The most one `read` may ask for; a larger file is read in pieces */
export const MaxRead = 4 << 20

const Mutating = new Set(['write', 'create', 'mkdir', 'unlink', 'rmdir', 'rename', 'link', 'touch'])

/** A path as the protocol allows it, or `undefined`: absolute, no `.` or `..` parts, no NUL, not absurdly long */
export function cleanPath(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || path.includes('\0')) return undefined
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return undefined
    parts.push(part)
  }
  return '/' + parts.join('/')
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export interface ServeFsOptions {
  /** Refuse every operation that changes anything (`EROFS`) */
  readOnly?: boolean
  /** Called with each failure the backend raised, for logging */
  onError?: (op: string, path: string | undefined, error: unknown) => void
}

/**
 * Answers a peer's filesystem requests from `backend`. Only the operations in `ExportFs` exist; a request is checked before the
 * backend sees it, and they are carried out one at a time in the order they arrived, so a write followed by a truncate means
 * that and not the reverse.
 */
export function serveFs(stream: MessageStream, backend: ExportFs, options: ServeFsOptions = {}) {
  let queue: Promise<unknown> = Promise.resolve()

  const handle = async (request: { [key: string]: Value }): Promise<Value> => {
    const op = request['op']
    const args = request['a']
    if (typeof op !== 'string' || !Array.isArray(args)) throw new FsError('EINVAL', 'bad request')
    if (options.readOnly && Mutating.has(op)) throw new FsError('EROFS', 'this export is read-only')

    const path = (index: number) => {
      const clean = cleanPath(args[index])
      if (clean === undefined) throw new FsError('EINVAL', 'bad path')
      return clean
    }
    const number = (index: number) => {
      const value = args[index]
      if (!isNumber(value)) throw new FsError('EINVAL', 'bad number')
      return value
    }
    const point = (list: Value | undefined, name: string) => {
      const value = list && typeof list === 'object' && !Array.isArray(list) && !(list instanceof Uint8Array) ? list[name] : undefined
      return value === undefined || value === null ? undefined : isNumber(value) ? value : (() => { throw new FsError('EINVAL', `bad ${name}`) })()
    }

    switch (op) {
      case 'stat': return { ...await backend.stat(path(0)) }
      case 'readdir': return await backend.readdir(path(0))
      case 'read': {
        const start = number(1)
        const end = number(2)
        if (end < start || end - start > MaxRead) throw new FsError('EINVAL', 'bad range')
        return await backend.read(path(0), start, end)
      }
      case 'write': {
        const data = args[2]
        if (!(data instanceof Uint8Array)) throw new FsError('EINVAL', 'bad data')
        await backend.write(path(0), number(1), data)
        return null
      }
      case 'create': return { ...await backend.create(path(0), number(1)) }
      case 'mkdir': return { ...await backend.mkdir(path(0), number(1)) }
      case 'unlink': await backend.unlink(path(0)); return null
      case 'rmdir': await backend.rmdir(path(0)); return null
      case 'rename': await backend.rename(path(0), path(1)); return null
      case 'link': await backend.link(path(0), path(1)); return null
      case 'touch': {
        const change = args[1]
        await backend.touch(path(0), {
          mode: point(change, 'mode'), atimeMs: point(change, 'atimeMs'), mtimeMs: point(change, 'mtimeMs'), size: point(change, 'size')
        })
        return null
      }
      case 'summary': return { ...await backend.summary({ files: number(0), bytes: number(1) }) }
      case 'ping': return null
      default: throw new FsError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
    }
  }

  stream.onMessage = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return stream.channel.close(new PeerError('protocol', 'bad request'))
    const request = value
    const id = request['id']
    if (typeof id !== 'number') return stream.channel.close(new PeerError('protocol', 'request without an id'))
    queue = queue.then(async () => {
      if (stream.closed) return
      let reply: Value
      try {
        reply = { id, v: await handle(request) }
      } catch (error) {
        options.onError?.(String(request['op']), typeof (request['a'] as Value[] | undefined)?.[0] === 'string' ? (request['a'] as string[])[0] : undefined, error)
        const code = error instanceof FsError ? error.code : typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'EIO'
        // The message is the backend's own and may name host paths; the code is what the far side acts on
        reply = { id, e: { c: code, m: error instanceof FsError ? error.message : code } }
      }
      await stream.send(reply).catch(() => {})
    })
  }
}

/** The asking side: sends a request and waits for its answer */
export class FsClient {
  private readonly _pending = new Map<number, { resolve(value: Value): void, reject(error: Error): void, timer: ReturnType<typeof setTimeout> }>()
  private _next = 1

  constructor(readonly stream: MessageStream, readonly timeout = 30_000) {
    stream.onMessage = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) return
      const id = value['id']
      const pending = typeof id === 'number' ? this._pending.get(id) : undefined
      if (!pending) return
      this._pending.delete(id as number)
      clearTimeout(pending.timer)
      const failure = value['e']
      if (failure && typeof failure === 'object' && !Array.isArray(failure) && !(failure instanceof Uint8Array)) {
        pending.reject(new FsError(typeof failure['c'] === 'string' ? failure['c'] : 'EIO', typeof failure['m'] === 'string' ? failure['m'] : undefined))
      } else pending.resolve(value['v'] ?? null)
    }
    void stream.channel.done.then(() => {
      const failure = this._ended()
      for (const [, pending] of this._pending) { clearTimeout(pending.timer); pending.reject(failure) }
      this._pending.clear()
    })
  }

  /** Why the channel ended, in the other side's words when it gave a reason (`no export named x`) */
  private _ended() {
    const reason = this.stream.channel.error
    return new FsError('ENOTCONN', reason && reason.code !== 'closed' ? reason.message : 'the connection to the other machine ended')
  }

  get closed() { return this.stream.closed }

  call(op: string, ...args: Value[]): Promise<Value> {
    if (this.stream.closed) return Promise.reject(this._ended())
    const id = this._next++
    return new Promise<Value>((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new FsError('ETIMEDOUT', `${op} timed out`)) }, this.timeout)
      this._pending.set(id, { resolve, reject, timer })
      this.stream.send({ id, op, a: args }).catch(() => {
        if (this._pending.delete(id)) { clearTimeout(timer); reject(this._ended()) }
      })
    })
  }

  close() { this.stream.channel.close() }
}
