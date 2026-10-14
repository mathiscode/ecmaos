import { EPOLLIN, EPOLLOUT, WaitQueue } from '@zenfs/linux'
import type { FileOperations } from '@zenfs/linux'
import { withErrno } from 'kerium'

/** Anything that can cross a device channel: what a session's controls and events carry */
export type Plain = string | number | boolean | null | Uint8Array | Plain[] | { [key: string]: Plain }

/**
 * One open of a device. It is the shape `@ecmaos/peer`'s `serveDevice` serves to another machine, and the shape a `/dev` node
 * made by `sessionOperations` reads from and writes to, so a driver is written once and works both ways. (Declared here
 * instead of imported, so the device packages need nothing from the peer package; the two fit.)
 */
export interface DeviceSession {
  info: { kind: string, read: boolean, write: boolean, [key: string]: Plain }
  /** The next bytes the device produced, or `undefined` once it has ended. Called again only after the last chunk was taken. */
  read?(): Promise<Uint8Array | undefined>
  /** Sends bytes to the device. Called one at a time, in order. */
  write?(data: Uint8Array): Promise<void>
  /** An adapter-defined operation; one it does not know is refused with `code: 'ENOSYS'` */
  control?(op: string, args: Plain[]): Promise<Plain>
  /** Set by whoever serves the session; the adapter calls it for things that happen on the device */
  emit?: (name: string, data: Plain) => void
  close(): void | Promise<void>
}

/** Raised by an adapter for a refused call; `code` is what the far side sees */
export class SessionError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'SessionError'
  }
}

/** One JSON value and a newline, as the text streams (geolocation, sensors) send their readings */
export const jsonLine = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value) + '\n')

export const isPlainMap = (value: unknown): value is { [key: string]: Plain } =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)

/**
 * Chunks an adapter has produced that nobody has taken yet. A device that keeps talking while no one listens (a controller,
 * a sensor) must not grow memory without end, so beyond `limit` chunks the oldest are dropped, as hardware drops what it
 * cannot hold. `end` makes `next` give `undefined` once what is queued has been taken.
 */
export class Feed {
  private readonly _queue: Uint8Array[] = []
  private _waiting: { resolve: (chunk: Uint8Array | undefined) => void, reject: (error: Error) => void } | undefined
  private _ended = false
  private _failure: Error | undefined

  constructor(readonly limit = 1024) {}

  get ended() { return this._ended }
  get length() { return this._queue.length }

  push(chunk: Uint8Array) {
    if (this._ended) return
    if (this._waiting) {
      const waiting = this._waiting
      this._waiting = undefined
      waiting.resolve(chunk)
      return
    }
    this._queue.push(chunk)
    if (this._queue.length > this.limit) this._queue.shift()
  }

  end() {
    this._ended = true
    const waiting = this._waiting
    this._waiting = undefined
    if (waiting) {
      if (this._failure) waiting.reject(this._failure)
      else waiting.resolve(undefined)
    }
  }

  /** Ends the feed with an error: what is queued is still taken, then `next` rejects with `error` instead of giving the end of the file */
  fail(error: Error) {
    if (this._ended) return
    this._failure = error
    this.end()
  }

  next(): Promise<Uint8Array | undefined> {
    return new Promise((resolve, reject) => {
      const chunk = this._queue.shift()
      if (chunk) resolve(chunk)
      else if (this._ended) { if (this._failure) reject(this._failure); else resolve(undefined) }
      else this._waiting = { resolve, reject }
    })
  }
}

/**
 * A session cut down to its first chunk: what a node reads when the device is a state and not a stream (the battery, a
 * position). Each open gives the state as it is then, and then the end of the file, so `cat` returns. The device is let go as
 * soon as that chunk has been taken.
 */
export function firstReading(session: DeviceSession): DeviceSession {
  const { read, ...rest } = session
  if (!read) return session
  let taken = false
  return {
    ...rest,
    async read() {
      if (taken) return undefined
      taken = true
      const chunk = await read.call(session)
      await Promise.resolve(session.close()).catch(() => {})
      return chunk
    }
  }
}

export interface SessionNodeOptions {
  /** Opens the device behind minor number `minor` when its node is first opened. Rejects if it cannot be opened. */
  open(minor: number): Promise<DeviceSession>
  /** The most that may be waiting to be written to the device before a writer has to wait; default 64 KiB */
  maxPending?: number
  /**
   * How long a session that no `open` announced (see below) may go without a read, write or poll before it is closed;
   * default 3000 ms
   */
  idleMs?: number
}

/** What an open `/dev` node is: the session, opened when the node is, and the bytes it has produced that nobody has read yet */
interface Link {
  session?: DeviceSession
  chunks: Uint8Array[]
  size: number
  /** Bytes handed to the device that it has not taken yet */
  pending: number
  queue: WaitQueue
  /** The device has ended (unplugged, closed) or could not be opened */
  ended: boolean
  /** The session has nothing to read (a write-only device), so a read gives the end of the file while writes still go through */
  unreadable?: boolean
  failure?: string
  /** Opens announced by `open` and not yet by `release`; a link with none is held only by use, and goes when idle */
  references: number
  touched: number
  timer?: ReturnType<typeof setTimeout>
}

/**
 * A session as a file, in the manner of a socket: bytes the device produces go into a buffer a read drains; a read with
 * nothing to give sleeps until the device has some (or has ended: then it reads as the end of the file); a write is handed to
 * the device, taking only what it has room for. Several opens of one node share one session, which ends with the last close.
 * Dispatch is by `file.devt.minor`, so one set of operations serves every node of a driver.
 *
 * The file system does not call `open` and `release` on a device node, so there are two ways a session begins and ends. The
 * kernel announces opens and closes of descriptors held by programs by calling `open` and `release` itself; the session then
 * lives from the first to the last. Any other caller (code that reads the file system object directly) just reads or writes: the
 * first access opens the session, and one that goes `idleMs` without a read, write or poll is closed.
 */
export function sessionOperations(options: SessionNodeOptions): FileOperations {
  const maxPending = options.maxPending ?? 64 * 1024
  const idleMs = options.idleMs ?? 3000
  const links = new Map<number, Link>()

  const start = async (minor: number, link: Link) => {
    try {
      const session = await options.open(minor)
      if (links.get(minor) !== link) { void Promise.resolve(session.close()).catch(() => {}); return }
      link.session = session
      link.queue.wake_up()
      if (!session.read) { link.unreadable = true; link.queue.wake_up(); return }
      for (;;) {
        const chunk = await session.read()
        if (!chunk) break
        link.chunks.push(chunk)
        link.size += chunk.length
        link.queue.wake_up()
      }
    } catch (error) {
      link.failure = error instanceof Error ? error.message : String(error)
    } finally {
      // A session that is only written to has not ended because it has nothing to read
      if (!link.unreadable || link.failure) link.ended = true
      link.queue.wake_up()
    }
  }

  const drop = (minor: number, found: Link) => {
    if (links.get(minor) === found) links.delete(minor)
    clearTimeout(found.timer)
    void Promise.resolve(found.session?.close()).catch(() => {})
    found.ended = true
    found.queue.wake_up()
  }

  /** Closes a link nobody announced an open for once it has been left alone for `idleMs` */
  const watch = (minor: number, found: Link) => {
    clearTimeout(found.timer)
    if (found.references > 0) return
    found.timer = setTimeout(() => {
      if (found.references > 0) return
      if (Date.now() - found.touched < idleMs) watch(minor, found)
      else drop(minor, found)
    }, idleMs)
    ;(found.timer as { unref?: () => void }).unref?.()
  }

  const create = (minor: number) => {
    const found: Link = { chunks: [], size: 0, pending: 0, queue: new WaitQueue(), ended: false, references: 0, touched: Date.now() }
    links.set(minor, found)
    void start(minor, found)
    return found
  }

  const link = (file: { devt: { minor: number } }) => {
    const minor = file.devt.minor
    const found = links.get(minor) ?? create(minor)
    found.touched = Date.now()
    watch(minor, found)
    return found
  }

  return {
    open: file => {
      const minor = file.devt.minor
      let found = links.get(minor)
      // A leftover from a lazy use that has ended is not what an open should get
      if (found && found.references === 0 && found.ended && found.size === 0) { drop(minor, found); found = undefined }
      found ??= create(minor)
      found.references++
      clearTimeout(found.timer)
    },
    release: file => {
      const minor = file.devt.minor
      const found = links.get(minor)
      if (!found || --found.references > 0) return
      drop(minor, found)
    },
    read: (file, buffer, start, end) => {
      const found = link(file)
      if (found.failure && found.size === 0) throw withErrno('EIO', found.failure)
      let done = 0
      while (done < end - start && found.chunks.length) {
        const chunk = found.chunks[0]!
        const count = Math.min(chunk.length, end - start - done)
        buffer.set(chunk.subarray(0, count), start + done)
        done += count
        if (count === chunk.length) found.chunks.shift()
        else found.chunks[0] = chunk.subarray(count)
      }
      found.size -= done
      return done
    },
    write: (file, buffer, offset) => {
      const found = link(file)
      if (found.ended) throw withErrno('EIO', found.failure ?? 'the device has closed')
      const session = found.session
      if (!session) throw withErrno('EAGAIN', 'the device is opening')
      if (!session.write) throw withErrno('EBADF', 'this device cannot be written to')
      const count = Math.min(buffer.length - offset, maxPending - found.pending)
      if (count <= 0) throw withErrno('EAGAIN')
      // The caller's buffer is reused as soon as this returns
      const data = buffer.slice(offset, offset + count)
      found.pending += count
      session.write(data)
        .catch(error => { found.failure = error instanceof Error ? error.message : String(error); found.ended = true })
        .finally(() => { found.pending -= count; found.queue.wake_up() })
      return count
    },
    poll: file => {
      const found = links.get(file.devt.minor)
      if (!found) return EPOLLIN | EPOLLOUT
      found.touched = Date.now()
      let events = 0
      if (found.size > 0 || found.ended || found.unreadable) events |= EPOLLIN
      if (found.ended || (found.session?.write && found.pending < maxPending)) events |= EPOLLOUT
      return events
    },
    poll_wait: file => links.get(file.devt.minor)?.queue
  }
}

/**
 * The operations of a driver's control node (`/dev/usb`, `/dev/serial`): it reads as an empty file and takes whatever is
 * written, since the node exists to be the name the device's command is run against and to be listed in `/dev`.
 */
export const controlOperations: FileOperations = {
  read: () => 0,
  write: (_file, buffer, offset) => buffer.length - offset
}
