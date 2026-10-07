import type { Transport } from './transport.ts'

export interface MemoryPairOptions {
  /** Called with each message before it is delivered; return false to drop it (to test loss handling) */
  filter?: (data: Uint8Array, from: 'a' | 'b') => boolean
}

/**
 * Two linked in-memory transports, for tests and for two peers in one process. Delivery is asynchronous (a microtask
 * per message) and ordered; closing either end closes the other. Messages are copied, as a real link would.
 */
export function memoryPair(options: MemoryPairOptions = {}): [a: MemoryTransport, b: MemoryTransport] {
  const a = new MemoryTransport('a', options)
  const b = new MemoryTransport('b', options)
  a.peer = b
  b.peer = a
  return [a, b]
}

export class MemoryTransport implements Transport {
  onMessage: ((data: Uint8Array) => void) | undefined
  onClose: ((error?: Error) => void) | undefined
  peer: MemoryTransport | undefined
  closed = false
  /** Messages and bytes sent, for assertions */
  sent = { messages: 0, bytes: 0 }

  constructor(private readonly _name: 'a' | 'b', private readonly _options: MemoryPairOptions) {}

  send(data: Uint8Array) {
    if (this.closed) throw new Error('transport is closed')
    this.sent.messages++
    this.sent.bytes += data.length
    if (this._options.filter && !this._options.filter(data, this._name)) return
    const copy = data.slice()
    const peer = this.peer
    queueMicrotask(() => { if (peer && !peer.closed) peer.onMessage?.(copy) })
  }

  close() {
    if (this.closed) return
    this.closed = true
    const peer = this.peer
    queueMicrotask(() => {
      this.onClose?.()
      if (peer && !peer.closed) { peer.closed = true; peer.onClose?.() }
    })
  }
}
