import type { Value } from './codec.ts'
import { PeerError } from './errors.ts'

/** What a channel needs from its connection */
export interface ChannelHost {
  sendData(channel: Channel, data: Uint8Array): void
  sendMessage(channel: Channel, value: Value): void
  sendCredit(channel: Channel, bytes: number): void
  sendClose(channel: Channel, error?: PeerError): void
  readonly maxFrame: number
}

/**
 * One multiplexed stream inside a connection: an ordered sequence of byte chunks (flow controlled, so a slow reader
 * slows the writer instead of filling memory) and control messages (small values, not flow controlled).
 *
 * Flow control is a credit window per direction. The receiver advertises how many bytes it will buffer; the sender
 * may have at most that many unconsumed; the receiver returns credit as the data is consumed. Credit is returned when
 * `onData` returns (the default), or when `grant` is called if `manualCredit` is set, which is how a reader that
 * buffers on its own (a device's read queue) keeps the writer paced by what the guest has actually read.
 */
export class Channel {
  /** Set once the other side has said how much it will take; writes wait for it */
  private _sendCredit = 0
  private _accepted = false
  private _waiters: Array<{ resume(): void, fail(error: PeerError): void }> = []
  private _queue: Uint8Array[] = []
  private _messages: Value[] = []
  private _outstanding = 0
  private _onData: ((data: Uint8Array) => void) | undefined
  private _onMessage: ((value: Value) => void) | undefined
  private _error: PeerError | undefined
  private _resolveClosed!: (error: PeerError | undefined) => void

  closed = false
  /** Resolves when the channel ends, with the reason if it did not end cleanly. Never rejects. */
  readonly done: Promise<PeerError | undefined>
  /** Return credit with `grant` instead of automatically after `onData` */
  manualCredit = false
  onClose: ((error?: PeerError) => void) | undefined

  constructor(
    readonly id: number,
    readonly kind: string,
    readonly params: Value,
    /** How many bytes this side will buffer from the other */
    readonly window: number,
    private readonly _host: ChannelHost
  ) {
    this.done = new Promise(resolve => { this._resolveClosed = resolve })
  }

  /** @internal The other side accepted and said how much it will buffer */
  _accept(window: number) {
    this._accepted = true
    this._sendCredit += window
    this._wake()
  }

  get error() { return this._error }
  /** How many bytes could be written right now without waiting */
  get writable() { return this._accepted && !this.closed ? this._sendCredit : 0 }

  /** Bytes received and not yet given back as credit */
  get outstanding() { return this._outstanding }

  /** Handler for incoming bytes. Chunks that arrived before it was set are delivered first, in order. */
  set onData(handler: ((data: Uint8Array) => void) | undefined) {
    this._onData = handler
    if (!handler) return
    while (this._queue.length && this._onData) this._deliver(this._queue.shift()!)
  }
  get onData() { return this._onData }

  /** Handler for incoming control messages; earlier ones are delivered first, in order */
  set onMessage(handler: ((value: Value) => void) | undefined) {
    this._onMessage = handler
    if (!handler) return
    while (this._messages.length && this._onMessage) this._onMessage(this._messages.shift()!)
  }
  get onMessage() { return this._onMessage }

  /**
   * Sends bytes, waiting for credit as needed and splitting into frames. Resolves when everything is handed to the
   * link; rejects if the channel closes first.
   */
  async write(data: Uint8Array): Promise<void> {
    let offset = 0
    while (offset < data.length) {
      this._assertOpen()
      const room = this.writable
      if (room === 0) { await this._waitForCredit(); continue }
      const size = Math.min(data.length - offset, room, this._host.maxFrame)
      this._sendCredit -= size
      this._host.sendData(this, data.subarray(offset, offset + size))
      offset += size
    }
  }

  /** Sends a control message. Ordered with the data, never waits for credit. */
  send(value: Value) {
    this._assertOpen()
    this._host.sendMessage(this, value)
  }

  /** Returns credit for `bytes` consumed. Only for `manualCredit` channels. */
  grant(bytes: number) {
    if (this.closed || bytes <= 0) return
    const count = Math.min(bytes, this._outstanding)
    if (count === 0) return
    this._outstanding -= count
    this._host.sendCredit(this, count)
  }

  /** Reads the next chunk, or `undefined` at the end of the channel. Not for use together with `onData`. */
  async read(): Promise<Uint8Array | undefined> {
    for (;;) {
      const chunk = this._queue.shift()
      if (chunk) { if (!this.manualCredit) this.grant(chunk.length); return chunk }
      if (this.closed) return undefined
      await new Promise<void>(resolve => { this._reader = resolve })
    }
  }
  private _reader: (() => void) | undefined

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const chunk = await this.read()
      if (!chunk) return
      yield chunk
    }
  }

  /** Ends the channel. With an error, the other side is told why. */
  close(error?: PeerError) {
    if (this.closed) return
    this._host.sendClose(this, error)
    this._end(error)
  }

  /** @internal Data from the other side */
  _receive(data: Uint8Array) {
    if (this.closed) return
    this._outstanding += data.length
    if (this._outstanding > this.window) throw new PeerError('protocol', `channel ${this.id} sent more than its credit`)
    if (this._onData) this._deliver(data)
    else { this._queue.push(data); this._reader?.(); this._reader = undefined }
  }

  /** @internal A control message from the other side */
  _receiveMessage(value: Value) {
    if (this.closed) return
    if (this._onMessage) this._onMessage(value)
    else this._messages.push(value)
  }

  /** @internal More credit from the other side */
  _credit(bytes: number) {
    if (this.closed) return
    this._sendCredit += bytes
    this._wake()
  }

  /** @internal The channel ended, by us or the other side */
  _end(error?: PeerError) {
    if (this.closed) return
    this.closed = true
    this._error = error
    for (const waiter of this._waiters.splice(0)) waiter.fail(error ?? new PeerError('closed', `channel ${this.id} is closed`))
    this._reader?.()
    this._reader = undefined
    this._resolveClosed(error)
    this.onClose?.(error)
  }

  private _deliver(data: Uint8Array) {
    try { this._onData!(data) } finally { if (!this.manualCredit) this.grant(data.length) }
  }

  private _assertOpen() {
    if (this.closed) throw this._error ?? new PeerError('closed', `channel ${this.id} is closed`)
  }

  private _waitForCredit() {
    return new Promise<void>((resolve, reject) => {
      this._waiters.push({ resume: resolve, fail: reject })
    })
  }

  private _wake() {
    for (const waiter of this._waiters.splice(0)) waiter.resume()
  }
}
