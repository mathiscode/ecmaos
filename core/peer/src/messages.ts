import { decodeValue, encodeValue } from './codec.ts'
import type { Value } from './codec.ts'
import type { Channel } from './channel.ts'
import { PeerError } from './errors.ts'

const DefaultMaxMessage = 64 << 20

/**
 * Whole messages over a channel's byte stream. A control message on a channel is limited to one frame; a message here can be
 * as large as `maxMessage` (a file's contents, say), is split into chunks that obey the channel's flow control, and is put back
 * together in order on the other side. Each is a 4-byte length and the encoded value.
 */
export class MessageStream {
  private _chunks: Uint8Array[] = []
  private _have = 0
  private _need = -1
  private readonly _max: number
  private readonly _maxReceive: number
  onMessage: ((value: Value) => void) | undefined

  /** `maxMessage` limits what is sent; `maxReceive` limits what is accepted (the same unless given), so a side that sends much can still take little */
  constructor(readonly channel: Channel, options: { maxMessage?: number, maxReceive?: number } = {}) {
    this._max = options.maxMessage ?? DefaultMaxMessage
    this._maxReceive = options.maxReceive ?? this._max
    channel.onData = data => this._receive(data)
  }

  get closed() { return this.channel.closed }

  /** Resolves once the whole message is handed to the link; rejects if the channel closes first */
  send(value: Value): Promise<void> {
    const body = encodeValue(value)
    if (body.length > this._max) return Promise.reject(new PeerError('limit', 'message is too large'))
    const frame = new Uint8Array(4 + body.length)
    new DataView(frame.buffer).setUint32(0, body.length)
    frame.set(body, 4)
    return this.channel.write(frame)
  }

  private _receive(data: Uint8Array) {
    // The chunk may be a view into a buffer the connection reuses
    this._chunks.push(data.slice())
    this._have += data.length
    try {
      for (;;) {
        if (this._need < 0) {
          if (this._have < 4) return
          const head = this._take(4)
          this._need = new DataView(head.buffer, head.byteOffset, 4).getUint32(0)
          if (this._need > this._maxReceive) throw new PeerError('limit', 'message is too large')
        }
        if (this._have < this._need) return
        const body = this._take(this._need)
        this._need = -1
        const value = decodeValue(body)
        this.onMessage?.(value)
      }
    } catch (error) {
      this.channel.close(error instanceof PeerError ? error : new PeerError('protocol', 'bad message'))
    }
  }

  private _take(count: number): Uint8Array {
    const out = new Uint8Array(count)
    let offset = 0
    while (offset < count) {
      const chunk = this._chunks[0]!
      const size = Math.min(chunk.length, count - offset)
      out.set(chunk.subarray(0, size), offset)
      offset += size
      if (size === chunk.length) this._chunks.shift()
      else this._chunks[0] = chunk.subarray(size)
    }
    this._have -= count
    return out
  }
}
