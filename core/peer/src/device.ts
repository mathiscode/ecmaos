import type { Channel } from './channel.ts'
import type { Value } from './codec.ts'
import { PeerError } from './errors.ts'

/** The channel kind for a device. The side that opens it asks to use a device the other side offers. */
export const DeviceChannel = 'device'
/** The channel kind for a device the opener offers: the side that accepts it makes a device node for it. */
export const DeviceShareChannel = 'device-share'

/** What the side that owns a device can say about it */
export interface DeviceInfo {
  /** `serial`, `file`, `loopback`, ... : what kind of device the far side is getting */
  kind: string
  /** Whether the user can read from it and write to it */
  read: boolean
  write: boolean
  /** Whatever else the adapter wants known (baud rate, vendor id, ...) */
  [key: string]: Value
}

/** One open of a device, on the machine that owns the device */
export interface DeviceSession {
  info: DeviceInfo
  /** The next bytes the device produced, or `undefined` once it has ended. Called again only after the last chunk was sent on. */
  read?(): Promise<Uint8Array | undefined>
  /** Sends bytes to the device. Called one at a time, in order. */
  write?(data: Uint8Array): Promise<void>
  /** An adapter-defined operation (`ioctl`); an operation the adapter does not know is `ENOSYS` */
  control?(op: string, args: Value[]): Promise<Value>
  /** Set by `serveDevice`; the adapter calls it for things that happen on the device (`signals`, `connect`, ...) */
  emit?: (name: string, data: Value) => void
  close(): void | Promise<void>
}

/** A device a machine is willing to hand out, under a name */
export interface DeviceSource {
  name: string
  open(): Promise<DeviceSession>
}

/** Raised by an adapter, and what crosses the wire as the code of a refused control call */
export class DeviceError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'DeviceError'
  }
}

/** A device description received from the other side, checked: a kind and whether it reads and writes, plus plain extras */
export function parseDeviceInfo(value: unknown): DeviceInfo | undefined {
  if (!isMap(value)) return undefined
  const { kind, read, write } = value
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > 32 || typeof read !== 'boolean' || typeof write !== 'boolean') return undefined
  return value as DeviceInfo
}

/** Everything written comes back as a read, in order: a device for trying a channel without hardware */
export function loopbackSession(): DeviceSession {
  const queue: Uint8Array[] = []
  let waiting: ((chunk: Uint8Array | undefined) => void) | undefined
  let closed = false
  return {
    info: { kind: 'loopback', read: true, write: true },
    read: () => new Promise(resolve => {
      const next = queue.shift()
      if (next) resolve(next)
      else if (closed) resolve(undefined)
      else waiting = resolve
    }),
    async write(data) {
      if (waiting) { const resolve = waiting; waiting = undefined; resolve(data) } else queue.push(data)
    },
    async control(op, args): Promise<Value> {
      if (op === 'ping') return 'pong'
      if (op === 'echo') return args
      throw new DeviceError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
    },
    close() { closed = true; waiting?.(undefined); waiting = undefined }
  }
}

const isMap = (value: unknown): value is { [key: string]: Value } =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)

/**
 * Serves one open device over `channel`. Bytes the device produces go to the other side as data, paced by the credit it
 * gives back as it reads them; bytes the other side sends are written to the device one at a time, and credit goes back
 * only once the device took them, so a slow device slows the sender instead of filling memory.
 */
export function serveDevice(channel: Channel, session: DeviceSession): void {
  channel.manualCredit = true
  let writing: Promise<void> = Promise.resolve()
  let ended = false

  const end = (error?: PeerError) => {
    if (ended) return
    ended = true
    void Promise.resolve(session.close()).catch(() => {})
    channel.close(error)
  }
  void channel.done.then(() => end())

  session.emit = (name, data) => { if (!channel.closed) channel.send({ t: 'event', n: name, d: data }) }

  channel.onData = data => {
    writing = writing.then(async () => {
      if (ended) return
      if (!session.write) return end(new PeerError('refused', 'this device cannot be written to'))
      try {
        await session.write(data)
        channel.grant(data.length)
      } catch (error) {
        end(new PeerError('internal', error instanceof Error ? error.message : 'write failed'))
      }
    })
  }

  channel.onMessage = value => {
    if (!isMap(value) || value['t'] !== 'ctl') return end(new PeerError('protocol', 'bad device message'))
    const id = value['id']
    const op = value['op']
    const args = value['a']
    if (typeof id !== 'number' || typeof op !== 'string' || op.length > 64 || !Array.isArray(args)) return end(new PeerError('protocol', 'bad control call'))
    void (async () => {
      let reply: Value
      try {
        if (!session.control) throw new DeviceError('ENOSYS', 'this device has no controls')
        reply = { t: 'ctl-r', id, v: await session.control(op, args) ?? null }
      } catch (error) {
        const code = error instanceof DeviceError ? error.code : typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'EIO'
        reply = { t: 'ctl-r', id, e: { c: code, m: error instanceof DeviceError ? error.message : code } }
      }
      if (!channel.closed) channel.send(reply)
    })()
  }

  // First thing the user sees: what it got
  channel.send({ t: 'info', i: session.info })

  if (session.read) {
    void (async () => {
      try {
        for (;;) {
          const chunk = await session.read!()
          if (!chunk) return end()
          if (chunk.length) await channel.write(chunk)
          if (ended) return
        }
      } catch (error) {
        // The channel went away (the user closed it) or the device failed (unplugged)
        if (!ended) end(new PeerError('internal', error instanceof Error ? error.message : 'device failed'))
      }
    })()
  }
}

/**
 * For a device the opener offers (`DeviceShareChannel`): the accepting side calls this once it has made its node for the
 * device. The channel is accepted before the handler has run, so without it the offering side could not tell a refusal
 * (a name already taken) from success until the channel closed.
 */
export function announceShared(channel: Channel): void { channel.send({ t: 'ready' }) }

/** The offering side waits for the other to have made its node; rejects with the other side's reason if it refused */
export function awaitShared(channel: Channel, timeout = 10_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PeerError('timeout', 'the other machine did not take the device')), timeout)
    channel.onMessage = value => { if (isMap(value) && value['t'] === 'ready') { clearTimeout(timer); resolve() } }
    void channel.done.then(error => { clearTimeout(timer); reject(error ?? new PeerError('closed', 'the other machine did not take the device')) })
  })
}

/** The using side of an open device: a byte stream with controls and events */
export class RemoteDevice {
  private readonly _pending = new Map<number, { resolve(value: Value): void, reject(error: Error): void, timer: ReturnType<typeof setTimeout> }>()
  private _next = 1
  private _info: DeviceInfo | undefined
  private readonly _ready: Promise<DeviceInfo>
  private _resolveReady!: (info: DeviceInfo) => void
  /** Bytes that arrived; the user takes them with `take`, which also returns the credit */
  private readonly _chunks: Uint8Array[] = []
  private _size = 0
  /** Bytes handed to the channel whose credit it has not taken yet (it does so a moment later, not at the call) */
  private _sending = 0

  /** Something arrived (bytes, an event) or the device ended */
  onChange: (() => void) | undefined
  onEvent: ((name: string, data: Value) => void) | undefined

  constructor(readonly channel: Channel, readonly timeout = 10_000) {
    channel.manualCredit = true
    this._ready = new Promise(resolve => { this._resolveReady = resolve })
    channel.onWritable = () => this.onChange?.()
    channel.onData = data => { this._chunks.push(data); this._size += data.length; this.onChange?.() }
    channel.onMessage = value => {
      if (!isMap(value)) return
      switch (value['t']) {
        case 'info':
          if (isMap(value['i']) && typeof value['i']['kind'] === 'string' && !this._info) {
            this._info = value['i'] as DeviceInfo
            this._resolveReady(this._info)
          }
          break
        case 'event':
          if (typeof value['n'] === 'string') this.onEvent?.(value['n'], value['d'] ?? null)
          break
        case 'ctl-r': {
          const id = value['id']
          const pending = typeof id === 'number' ? this._pending.get(id) : undefined
          if (!pending) break
          this._pending.delete(id as number)
          clearTimeout(pending.timer)
          const failure = value['e']
          if (isMap(failure)) pending.reject(new DeviceError(typeof failure['c'] === 'string' ? failure['c'] : 'EIO', typeof failure['m'] === 'string' ? failure['m'] : undefined))
          else pending.resolve(value['v'] ?? null)
          break
        }
      }
    }
    void channel.done.then(() => {
      const failure = this._ended()
      for (const [, pending] of this._pending) { clearTimeout(pending.timer); pending.reject(failure) }
      this._pending.clear()
      this.onChange?.()
    })
  }

  private _ended() {
    const reason = this.channel.error
    return new DeviceError('ENODEV', reason && reason.code !== 'closed' ? reason.message : 'the device is gone')
  }

  /** Resolves with what the device is once the owner has said so; rejects if it ends first */
  info(): Promise<DeviceInfo> {
    return Promise.race([this._ready, this.channel.done.then(() => { throw this._ended() })])
  }

  get closed() { return this.channel.closed }
  /** Bytes waiting to be taken */
  get available() { return this._size }
  /** Bytes that could be written now without waiting */
  get writable() { return Math.max(0, this.channel.writable - this._sending) }

  /** Takes up to `into.length` of the bytes that arrived, and gives that much credit back */
  take(into: Uint8Array): number {
    let done = 0
    while (done < into.length && this._chunks.length) {
      const chunk = this._chunks[0]!
      const count = Math.min(chunk.length, into.length - done)
      into.set(chunk.subarray(0, count), done)
      done += count
      if (count === chunk.length) this._chunks.shift()
      else this._chunks[0] = chunk.subarray(count)
    }
    this._size -= done
    this.channel.grant(done)
    return done
  }

  /** Sends as much of `data` as there is credit for right now and returns how much went; `onChange` fires when more can */
  write(data: Uint8Array): number {
    if (this.channel.closed) throw this._ended()
    const count = Math.min(data.length, this.writable)
    if (count > 0) {
      this._sending += count
      this.channel.write(data.slice(0, count)).catch(() => {}).finally(() => { this._sending -= count })
    }
    return count
  }

  control(op: string, ...args: Value[]): Promise<Value> {
    if (this.channel.closed) return Promise.reject(this._ended())
    const id = this._next++
    return new Promise<Value>((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new DeviceError('ETIMEDOUT', `${op} timed out`)) }, this.timeout)
      this._pending.set(id, { resolve, reject, timer })
      try { this.channel.send({ t: 'ctl', id, op, a: args }) } catch (error) {
        this._pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  close() { this.channel.close() }
}
