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

  /** Forgets what is queued, for a source whose chunks no longer mean what they did (the camera's format changed) */
  clear() { this._queue.length = 0 }

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
  /** Told when a session fails to open or ends in an error, so a driver can log what the errno a program sees cannot carry */
  onError?(error: Error, minor: number): void
  /** The most that may be waiting to be written to the device before a writer has to wait; default 64 KiB */
  maxPending?: number
  /**
   * How long a session that no `open` announced (see below) may go without a read, write or poll before it is closed;
   * default 3000 ms
   */
  idleMs?: number
  /**
   * Each chunk the device produces is a whole message (a HID report): a read gives one and no more, and what does not fit in
   * the caller's buffer is dropped, as a datagram's is. Without it, reads run chunks together as a stream.
   */
  packets?: boolean
  /**
   * Requests the node answers with `ioctl`, for a device whose driver has controls a program reaches by number (hidraw's
   * `HIDIOCGFEATURE`). `accepts` says which numbers are the driver's; `run` answers one against the open session (waiting for
   * it, if it is still opening), with the bytes to give back or a count, or a promise of either. `flags` are the open file's
   * (`O_NONBLOCK` among them), for a request that waits, and `file` is the open file itself (undefined when the caller has no
   * descriptor, as a call made by path has none): the same object for every request on one descriptor.
   */
  ioctl?: {
    accepts(request: number): boolean
    run(session: DeviceSession, request: number, arg: unknown, minor: number, flags: number, file?: unknown): unknown
    /** Whether `request` changes what the device produces, so what was read ahead is stale (a camera's `VIDIOC_S_FMT`) and is dropped once it has run */
    flushes?(request: number): boolean
  }
  /**
   * Which of `EPOLLIN` and `EPOLLOUT` the open session is ready for, and what to sleep on until that changes, for a device whose
   * readiness is not its chunks (a sound card is ready for a write when its buffer has room). Without them a node is ready as
   * its buffers say.
   */
  poll?(session: DeviceSession): number
  pollQueue?(session: DeviceSession): WaitQueue | undefined
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
  /** Settles once the session is open (or could not be) */
  opened: Promise<void>
  /** The session has nothing to read (a write-only device), so a read gives the end of the file while writes still go through */
  unreadable?: boolean
  settle?: () => void
  failure?: string
  /** The errno the failure came with (a `SessionError`'s code), when it names one */
  failureCode?: string
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
export function sessionOperations(options: SessionNodeOptions): FileOperations & { hangup(minor: number): void } {
  const maxPending = options.maxPending ?? 64 * 1024
  const idleMs = options.idleMs ?? 3000
  const links = new Map<number, Link>()

  const fail = (minor: number, found: Link, error: unknown) => {
    found.failure = error instanceof Error ? error.message : String(error)
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) found.failureCode = code
    options.onError?.(error instanceof Error ? error : new Error(found.failure), minor)
  }

  const start = async (minor: number, link: Link) => {
    try {
      const session = await options.open(minor)
      if (links.get(minor) !== link) { void Promise.resolve(session.close()).catch(() => {}); return }
      link.session = session
      link.settle?.()
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
      fail(minor, link, error)
    } finally {
      // A session that is only written to has not ended because it has nothing to read
      if (!link.unreadable || link.failure) link.ended = true
      link.settle?.()
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
    let settle!: () => void
    const opened = new Promise<void>(resolve => { settle = resolve })
    const found: Link = { chunks: [], size: 0, pending: 0, queue: new WaitQueue(), ended: false, references: 0, touched: Date.now(), opened }
    found.settle = settle
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
    /** The device behind `minor` has gone: whoever is reading or writing gets `ENODEV` (a reader that is waiting wakes), and the session closes */
    hangup: minor => {
      const found = links.get(minor)
      if (!found) return
      found.failure = 'the device has gone'
      found.failureCode = 'ENODEV'
      found.chunks.length = 0
      found.size = 0
      drop(minor, found)
    },
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
      if (found.failure && found.size === 0) throw withErrno((found.failureCode ?? 'EIO') as Parameters<typeof withErrno>[0], found.failure)
      let done = 0
      while (done < end - start && found.chunks.length) {
        const chunk = found.chunks[0]!
        const count = Math.min(chunk.length, end - start - done)
        buffer.set(chunk.subarray(0, count), start + done)
        done += count
        if (count === chunk.length || options.packets) found.chunks.shift()
        else found.chunks[0] = chunk.subarray(count)
        if (options.packets) { found.size -= chunk.length - count; break }
      }
      found.size -= done
      return done
    },
    write: (file, buffer, offset) => {
      const found = link(file)
      if (found.ended) throw withErrno((found.failureCode ?? 'EIO') as Parameters<typeof withErrno>[0], found.failure ?? 'the device has closed')
      const session = found.session
      if (!session) throw withErrno('EAGAIN', 'the device is opening')
      if (!session.write) throw withErrno('EBADF', 'this device cannot be written to')
      const count = Math.min(buffer.length - offset, maxPending - found.pending)
      if (count <= 0) throw withErrno('EAGAIN')
      // The caller's buffer is reused as soon as this returns
      const data = buffer.slice(offset, offset + count)
      found.pending += count
      session.write(data)
        .catch(error => { fail(file.devt.minor, found, error); found.ended = true })
        .finally(() => { found.pending -= count; found.queue.wake_up() })
      return count
    },
    poll: file => {
      const found = links.get(file.devt.minor)
      if (!found) return EPOLLIN | EPOLLOUT
      found.touched = Date.now()
      if (options.poll && found.session) return options.poll(found.session)
      let events = 0
      if (found.size > 0 || found.ended || found.unreadable) events |= EPOLLIN
      if (found.ended || (found.session?.write && found.pending < maxPending)) events |= EPOLLOUT
      return events
    },
    poll_wait: file => {
      const found = links.get(file.devt.minor)
      return (found?.session && options.pollQueue?.(found.session)) || found?.queue
    },
    ...(options.ioctl && { ioctl: sessionIoctl(options.ioctl, file => link(file)) })
  }
}

/** The `ioctl` table of a session node: any request the driver `accepts` is run against the node's session once it is open */
function sessionIoctl(driver: NonNullable<SessionNodeOptions['ioctl']>, linkOf: (file: { devt: { minor: number } }) => Link): FileOperations['ioctl'] {
  return new Proxy({}, {
    get: (_target, key) => {
      const request = Number(key)
      if (!Number.isInteger(request) || !driver.accepts(request >>> 0)) return undefined
      return async (context: { file?: { flag: number } }, file: { devt: { minor: number } }, arg?: unknown) => {
        const found = linkOf(file)
        await found.opened
        if (found.ended && !found.session) throw withErrno((found.failureCode ?? 'ENODEV') as Parameters<typeof withErrno>[0], found.failure)
        if (!found.session || found.ended) throw withErrno('ENODEV')
        const result = await driver.run(found.session, request >>> 0, arg, file.devt.minor, context?.file?.flag ?? 0, context?.file)
        if (driver.flushes?.(request >>> 0)) { found.chunks.length = 0; found.size = 0 }
        return result
      }
    },
    has: (_target, key) => Number.isInteger(Number(key)) && driver.accepts(Number(key) >>> 0)
  }) as FileOperations['ioctl']
}

/**
 * The operations of a driver's control node (`/dev/usb`, `/dev/serialctl`): it reads as an empty file and takes whatever is
 * written, since the node exists to be the name the device's command is run against and to be listed in `/dev`.
 */
export const controlOperations: FileOperations = {
  read: () => 0,
  write: (_file, buffer, offset) => buffer.length - offset
}

/** Where a driver keeps its table of minors between boots */
export interface MinorStore {
  read(): Promise<string | undefined>
  write(text: string): Promise<void>
}

/**
 * Minor numbers that stay with a device. A browser lists the devices it has granted in an order that shifts when one is
 * forgotten, so numbering by position would hand `usb1` to a different device after a reboot. Each device is named by a key
 * (what identifies it: ids, serial number), and the first time a key is seen it gets the next number after the highest ever
 * given; a number is never reused, so removing a device leaves a gap and the ones after it keep their names. Devices that look
 * the same (same key) are told apart by the order the browser lists them in.
 */
export class StableMinors {
  private table: Record<string, number> | undefined

  constructor(private readonly store: MinorStore) {}

  /** The keys with a `#2`, `#3` added to repeats, so two identical devices get a key each */
  static unique(keys: string[]): string[] {
    const seen = new Map<string, number>()
    return keys.map(key => {
      const count = (seen.get(key) ?? 0) + 1
      seen.set(key, count)
      return count === 1 ? key : `${key}#${count}`
    })
  }

  private async load(): Promise<Record<string, number>> {
    if (this.table) return this.table
    const table: Record<string, number> = {}
    try {
      const parsed = JSON.parse(await this.store.read() ?? '{}') as unknown
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) if (Number.isInteger(value) && (value as number) >= 1) table[key] = value as number
      }
    } catch { /* an unreadable table starts again */ }
    return this.table = table
  }

  /** The minor of each device, in the order of `keys`; devices not seen before are numbered and the table is saved */
  async assign(keys: string[]): Promise<number[]> {
    const table = await this.load()
    const unique = StableMinors.unique(keys)
    let next = Math.max(0, ...Object.values(table)) + 1
    let changed = false
    const minors = unique.map(key => {
      if (table[key] === undefined) { table[key] = next++; changed = true }
      return table[key]!
    })
    if (changed) await this.store.write(JSON.stringify(table)).catch(() => { /* the numbers hold for this boot */ })
    return minors
  }

  /** The position in `keys` of the device that has this minor, or -1 when it is not there now */
  async find(keys: string[], minor: number): Promise<number> {
    const table = await this.load()
    return StableMinors.unique(keys).findIndex(key => table[key] === minor)
  }
}

/** A `MinorStore` in a file; `fs` is the file system's `fs` (only `promises.readFile`, `writeFile` and `mkdir` are used) */
export function fileMinorStore(fs: { promises: { readFile(path: string, encoding: 'utf8'): Promise<string>, writeFile(path: string, data: string): Promise<void>, mkdir(path: string, options: { recursive: true }): Promise<unknown> } }, path: string): MinorStore {
  return {
    read: () => fs.promises.readFile(path, 'utf8').catch(() => undefined),
    async write(text) {
      await fs.promises.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true })
      await fs.promises.writeFile(path, text)
    }
  }
}
