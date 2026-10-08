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
  private _waiting: ((chunk: Uint8Array | undefined) => void) | undefined
  private _ended = false

  constructor(readonly limit = 1024) {}

  get ended() { return this._ended }
  get length() { return this._queue.length }

  push(chunk: Uint8Array) {
    if (this._ended) return
    if (this._waiting) {
      const resolve = this._waiting
      this._waiting = undefined
      resolve(chunk)
      return
    }
    this._queue.push(chunk)
    if (this._queue.length > this.limit) this._queue.shift()
  }

  end() {
    this._ended = true
    const resolve = this._waiting
    this._waiting = undefined
    resolve?.(undefined)
  }

  next(): Promise<Uint8Array | undefined> {
    return new Promise(resolve => {
      const chunk = this._queue.shift()
      if (chunk) resolve(chunk)
      else if (this._ended) resolve(undefined)
      else this._waiting = resolve
    })
  }
}

export interface SessionNodeOptions {
  /** Opens the device behind minor number `minor` when its node is first opened. Rejects if it cannot be opened. */
  open(minor: number): Promise<DeviceSession>
  /** The most that may be waiting to be written to the device before a writer has to wait; default 64 KiB */
  maxPending?: number
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
  failure?: string
  references: number
}

/**
 * A session as a file, in the manner of a socket: bytes the device produces go into a buffer a read drains; a read with
 * nothing to give sleeps until the device has some (or has ended: then it reads as the end of the file); a write is handed to
 * the device, taking only what it has room for. Several opens of one node share one session, which ends with the last close.
 * Dispatch is by `file.devt.minor`, so one set of operations serves every node of a driver.
 */
export function sessionOperations(options: SessionNodeOptions): FileOperations {
  const maxPending = options.maxPending ?? 64 * 1024
  const links = new Map<number, Link>()

  const start = async (minor: number, link: Link) => {
    try {
      const session = await options.open(minor)
      if (link.references === 0) { void Promise.resolve(session.close()).catch(() => {}); return }
      link.session = session
      link.queue.wake_up()
      if (!session.read) return
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
      link.ended = true
      link.queue.wake_up()
    }
  }

  const link = (file: { devt: { minor: number } }) => {
    const found = links.get(file.devt.minor)
    if (!found) throw withErrno('EBADF')
    return found
  }

  return {
    open: file => {
      let found = links.get(file.devt.minor)
      if (!found) {
        found = { chunks: [], size: 0, pending: 0, queue: new WaitQueue(), ended: false, references: 0 }
        links.set(file.devt.minor, found)
        void start(file.devt.minor, found)
      }
      found.references++
    },
    release: file => {
      const found = links.get(file.devt.minor)
      if (!found || --found.references > 0) return
      links.delete(file.devt.minor)
      void Promise.resolve(found.session?.close()).catch(() => {})
      found.ended = true
      found.queue.wake_up()
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
      let events = 0
      if (found.size > 0 || found.ended) events |= EPOLLIN
      if (found.ended || (found.session?.write && found.pending < maxPending)) events |= EPOLLOUT
      return events
    },
    poll_wait: file => links.get(file.devt.minor)?.queue
  }
}
