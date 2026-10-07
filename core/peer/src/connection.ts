import { Reader, Writer, readValue, writeValue } from './codec.ts'
import type { Value } from './codec.ts'
import { Channel } from './channel.ts'
import type { ChannelHost } from './channel.ts'
import { PeerError } from './errors.ts'
import type { Transport } from './transport.ts'

/** The wire protocol versions this build speaks. Bump `Max` for a change older peers cannot read. */
export const ProtocolMin = 1
export const ProtocolMax = 1

const Frame = { Hello: 1, Ping: 2, Pong: 3, Open: 4, Accept: 5, Data: 6, Message: 7, Credit: 8, Close: 9 } as const

export type Role = 'client' | 'server'

export interface ConnectionOptions {
  /** Who dialled. Channel ids are odd for the client and even for the server, so both sides can open channels. */
  role: Role
  /** Opaque values for the layers above (a name, capabilities); sent in `hello` and readable as `peerMeta` */
  meta?: { [key: string]: Value }
  /** Largest frame accepted, bytes. Default 1 MiB. */
  maxFrame?: number
  /** Most channels open at once, either direction. Default 256. */
  maxChannels?: number
  /** How much each channel buffers from the other side, bytes. Default 256 KiB. */
  window?: number
  /** Milliseconds to wait for the other side's `hello`. Default 10000. */
  helloTimeout?: number
  /** Ping every `interval` ms and drop the link if no reply comes within `timeout` ms */
  keepalive?: { interval: number, timeout: number }
}

export interface OpenOptions {
  params?: Value
  /** Bytes this side will buffer on the channel. Defaults to the connection's window. */
  window?: number
  /** Give up waiting for the other side to accept, ms. Default 10000. */
  timeout?: number
}

/** Handles an incoming channel. Throw (or reject) to refuse it; the other side sees `refused` with the message. */
export type ChannelHandler = (channel: Channel) => void | Promise<void>

const DefaultMaxFrame = 1 << 20
const DefaultWindow = 256 << 10

/**
 * A peer-to-peer link: the version handshake, frames, and channels multiplexed over one transport. It knows nothing
 * about what channels carry (a terminal, files, a device) or who may open which; the layers above register handlers by
 * channel kind and decide.
 */
export class Connection implements ChannelHost {
  readonly role: Role
  readonly maxFrame: number
  /** Resolves with the negotiated version once the handshake is done; rejects if it fails */
  readonly ready: Promise<number>
  /** Resolves when the connection ends, with the reason if it did not end cleanly. Never rejects. */
  readonly done: Promise<PeerError | undefined>

  version = 0
  peerMeta: { [key: string]: Value } = {}
  closed = false
  onClose: ((error?: PeerError) => void) | undefined

  private readonly _transport: Transport
  private readonly _channels = new Map<number, Channel>()
  private readonly _opening = new Map<number, { resolve(channel: Channel): void, reject(error: PeerError): void, timer: ReturnType<typeof setTimeout> | undefined }>()
  private readonly _handlers = new Map<string, ChannelHandler>()
  private readonly _pings = new Map<number, { start: number, resolve(rtt: number): void }>()
  private readonly _maxChannels: number
  private readonly _window: number
  private _nextId: number
  private _nextPing = 1
  private _helloTimer: ReturnType<typeof setTimeout> | undefined
  private _keepalive: ReturnType<typeof setInterval> | undefined
  private _resolveReady!: (version: number) => void
  private _rejectReady!: (error: PeerError) => void
  private _resolveDone!: (error: PeerError | undefined) => void

  constructor(transport: Transport, options: ConnectionOptions) {
    this._transport = transport
    this.role = options.role
    this.maxFrame = options.maxFrame ?? DefaultMaxFrame
    this._maxChannels = options.maxChannels ?? 256
    this._window = options.window ?? DefaultWindow
    this._nextId = options.role === 'client' ? 1 : 2

    this.ready = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject })
    this.ready.catch(() => {}) // a failed handshake is reported through `done` as well; do not warn when nobody awaited `ready`
    this.done = new Promise(resolve => { this._resolveDone = resolve })

    transport.onMessage = data => this._onMessage(data)
    transport.onClose = error => this._end(error ? new PeerError('closed', error.message, { cause: error }) : undefined, false)

    const hello = new Writer()
    hello.u8(Frame.Hello); hello.varuint(0)
    writeValue(hello, { min: ProtocolMin, max: ProtocolMax, meta: options.meta ?? {} })
    this._send(hello.finish())

    this._helloTimer = setTimeout(() => this._fail(new PeerError('timeout', 'no hello from the peer')), options.helloTimeout ?? 10_000)
    if (options.keepalive) {
      const { interval, timeout } = options.keepalive
      this._keepalive = setInterval(() => {
        if (!this.version) return
        this.ping(timeout).catch(error => this._fail(error instanceof PeerError ? error : new PeerError('timeout', 'keepalive failed')))
      }, interval)
    }
  }

  /** Handle incoming channels of this kind. One handler per kind; the last registered wins. */
  accept(kind: string, handler: ChannelHandler) { this._handlers.set(kind, handler) }

  /** Opens a channel to the other side and waits for it to accept */
  async open(kind: string, options: OpenOptions = {}): Promise<Channel> {
    await this.ready
    this._assertOpen()
    if (this._channels.size + this._opening.size >= this._maxChannels) throw new PeerError('limit', 'too many channels')
    const id = this._nextId
    this._nextId += 2
    const channel = new Channel(id, kind, options.params ?? null, options.window ?? this._window, this)
    this._channels.set(id, channel)

    const out = new Writer()
    out.u8(Frame.Open); out.varuint(id)
    writeValue(out, { kind, params: options.params ?? null, window: channel.window })
    this._send(out.finish())

    return await new Promise<Channel>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._opening.delete(id)
        this._channels.delete(id)
        channel.close(new PeerError('timeout', `${kind} was not accepted`))
        reject(new PeerError('timeout', `${kind} was not accepted`))
      }, options.timeout ?? 10_000)
      this._opening.set(id, { resolve, reject, timer })
    })
  }

  /** Round trip time in ms. Rejects with `timeout` if no reply comes in time. */
  async ping(timeout = 5_000): Promise<number> {
    await this.ready
    this._assertOpen()
    const nonce = this._nextPing++
    const start = performance.now()
    const out = new Writer()
    out.u8(Frame.Ping); out.varuint(0); out.varuint(nonce)
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { this._pings.delete(nonce); reject(new PeerError('timeout', 'ping timed out')) }, timeout)
      this._pings.set(nonce, { start, resolve: rtt => { clearTimeout(timer); resolve(rtt) } })
      this._send(out.finish())
    })
  }

  /** Ends the connection and every channel on it. With an error, the other side is told why. */
  close(error?: PeerError) {
    if (this.closed) return
    if (error) {
      const out = new Writer()
      out.u8(Frame.Close); out.varuint(0)
      writeValue(out, { code: error.code, message: error.message })
      try { this._send(out.finish()) } catch { /* the link is already gone */ }
    }
    this._end(error, true)
  }

  // ChannelHost
  sendData(channel: Channel, data: Uint8Array) {
    const out = new Writer(data.length + 8)
    out.u8(Frame.Data); out.varuint(channel.id); out.raw(data)
    this._send(out.finish())
  }
  sendMessage(channel: Channel, value: Value) {
    const out = new Writer()
    out.u8(Frame.Message); out.varuint(channel.id); writeValue(out, value)
    this._send(out.finish())
  }
  sendCredit(channel: Channel, bytes: number) {
    const out = new Writer()
    out.u8(Frame.Credit); out.varuint(channel.id); out.varuint(bytes)
    this._send(out.finish())
  }
  sendClose(channel: Channel, error?: PeerError) {
    this._channels.delete(channel.id)
    this._remember(channel.id)
    if (this.closed) return
    const out = new Writer()
    out.u8(Frame.Close); out.varuint(channel.id)
    writeValue(out, error ? { code: error.code, message: error.message } : null)
    try { this._send(out.finish()) } catch { /* the link is already gone */ }
  }

  private _send(frame: Uint8Array) {
    if (frame.length > this.maxFrame + 16) throw new PeerError('limit', 'frame is too large')
    this._transport.send(frame)
  }

  private _assertOpen() {
    if (this.closed) throw new PeerError('closed', 'the connection is closed')
  }

  private _onMessage(data: Uint8Array) {
    if (this.closed) return
    try {
      if (data.length > this.maxFrame + 16) throw new PeerError('limit', 'frame is too large')
      this._frame(new Reader(data))
    } catch (error) {
      this._fail(error instanceof PeerError ? error : new PeerError('protocol', 'bad frame', { cause: error }))
    }
  }

  private _frame(input: Reader) {
    const type = input.u8()
    const id = input.varuint()

    if (!this.version) {
      if (type !== Frame.Hello || id !== 0) throw new PeerError('protocol', 'expected hello first')
      return this._hello(input)
    }

    switch (type) {
      case Frame.Hello: throw new PeerError('protocol', 'second hello')
      case Frame.Ping: {
        const nonce = input.varuint()
        const out = new Writer()
        out.u8(Frame.Pong); out.varuint(0); out.varuint(nonce)
        this._send(out.finish())
        return
      }
      case Frame.Pong: {
        const nonce = input.varuint()
        const pending = this._pings.get(nonce)
        this._pings.delete(nonce)
        pending?.resolve(performance.now() - pending.start)
        return
      }
      case Frame.Open: return this._open(id, input)
      case Frame.Accept: {
        const window = input.varuint()
        const pending = this._opening.get(id)
        const channel = this._channels.get(id)
        if (!pending || !channel) throw new PeerError('protocol', `accept for unknown channel ${id}`)
        clearTimeout(pending.timer)
        this._opening.delete(id)
        channel._accept(window)
        pending.resolve(channel)
        return
      }
      case Frame.Data: {
        const channel = this._channels.get(id)
        // Data for a channel we just closed is expected (it was in flight); anything else unknown is a bug
        if (channel) channel._receive(input.rest())
        else if (!this._recentlyClosed(id)) throw new PeerError('protocol', `data for unknown channel ${id}`)
        return
      }
      case Frame.Message: {
        const channel = this._channels.get(id)
        if (channel) channel._receiveMessage(readValue(input))
        else if (!this._recentlyClosed(id)) throw new PeerError('protocol', `message for unknown channel ${id}`)
        return
      }
      case Frame.Credit: {
        const bytes = input.varuint()
        this._channels.get(id)?._credit(bytes)
        return
      }
      case Frame.Close: {
        const value = input.remaining ? readValue(input) : null
        const error = value && typeof value === 'object' && !(value instanceof Uint8Array) && !Array.isArray(value)
          ? PeerError.fromWire(value.code, value.message)
          : undefined
        if (id === 0) return this._end(error ?? new PeerError('closed', 'the peer closed the connection'), false)
        const pending = this._opening.get(id)
        if (pending) { clearTimeout(pending.timer); this._opening.delete(id); pending.reject(error ?? new PeerError('refused', 'the peer refused the channel')) }
        const channel = this._channels.get(id)
        this._channels.delete(id)
        this._remember(id)
        channel?._end(error)
        return
      }
      default: throw new PeerError('protocol', `unknown frame type ${type}`)
    }
  }

  private _hello(input: Reader) {
    const hello = readValue(input)
    if (!hello || typeof hello !== 'object' || hello instanceof Uint8Array || Array.isArray(hello)) throw new PeerError('protocol', 'bad hello')
    const { min, max, meta } = hello
    if (typeof min !== 'number' || typeof max !== 'number' || min > max) throw new PeerError('protocol', 'bad hello versions')
    const version = Math.min(max, ProtocolMax)
    if (version < Math.max(min, ProtocolMin)) throw new PeerError('version', `peer speaks ${min}-${max}, this side ${ProtocolMin}-${ProtocolMax}`)
    clearTimeout(this._helloTimer)
    this.version = version
    this.peerMeta = meta && typeof meta === 'object' && !(meta instanceof Uint8Array) && !Array.isArray(meta) ? meta : {}
    this._resolveReady(version)
  }

  private _open(id: number, input: Reader) {
    // The other side picks ids from its own parity; anything else would collide with ours
    const theirs = this.role === 'client' ? 0 : 1
    if (id % 2 !== theirs || id === 0) throw new PeerError('protocol', `channel id ${id} is not the peer's to open`)
    if (this._channels.has(id)) throw new PeerError('protocol', `channel ${id} is already open`)

    const spec = readValue(input)
    if (!spec || typeof spec !== 'object' || spec instanceof Uint8Array || Array.isArray(spec)) throw new PeerError('protocol', 'bad open')
    const { kind, params, window } = spec
    if (typeof kind !== 'string' || typeof window !== 'number' || !Number.isSafeInteger(window) || window < 0) throw new PeerError('protocol', 'bad open')

    const refuse = (error: PeerError) => {
      const out = new Writer()
      out.u8(Frame.Close); out.varuint(id)
      writeValue(out, { code: error.code, message: error.message })
      this._send(out.finish())
      this._remember(id)
    }

    if (this._channels.size + this._opening.size >= this._maxChannels) return refuse(new PeerError('limit', 'too many channels'))
    const handler = this._handlers.get(kind)
    if (!handler) return refuse(new PeerError('unsupported', `no handler for ${kind}`))

    const channel = new Channel(id, kind, params ?? null, this._window, this)
    this._channels.set(id, channel)
    channel._accept(window)

    // Accept first, so the handler can write at once; a handler that throws closes the channel with the reason
    const out = new Writer()
    out.u8(Frame.Accept); out.varuint(id); out.varuint(channel.window)
    this._send(out.finish())

    const failed = (error: unknown) => {
      channel.close(error instanceof PeerError ? error : new PeerError('refused', error instanceof Error ? error.message : String(error)))
    }
    try {
      const result = handler(channel)
      if (result && typeof (result as Promise<void>).then === 'function') (result as Promise<void>).catch(failed)
    } catch (error) { failed(error) }
  }

  // Ids of channels closed recently: a frame still in flight for one of them is not an error
  private readonly _closedIds = new Set<number>()
  private _remember(id: number) {
    this._closedIds.add(id)
    if (this._closedIds.size > 1024) this._closedIds.delete(this._closedIds.values().next().value!)
  }
  private _recentlyClosed(id: number) { return this._closedIds.has(id) }

  /** A protocol or timeout failure: tell the other side, then end */
  private _fail(error: PeerError) {
    this.close(error)
  }

  private _end(error: PeerError | undefined, closeTransport: boolean) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this._helloTimer)
    clearInterval(this._keepalive)
    const reason = error ?? new PeerError('closed', 'the connection is closed')
    if (!this.version) this._rejectReady(reason)
    for (const [, pending] of this._opening) { clearTimeout(pending.timer); pending.reject(reason) }
    this._opening.clear()
    this._pings.clear()
    for (const channel of [...this._channels.values()]) channel._end(error ?? new PeerError('closed', 'the connection is closed'))
    this._channels.clear()
    if (closeTransport) this._transport.close()
    this._resolveDone(error)
    this.onClose?.(error)
  }
}
