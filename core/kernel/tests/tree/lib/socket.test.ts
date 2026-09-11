import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EPOLLIN, EPOLLOUT } from '@zenfs/linux'
import { createSocket } from '#lib/socket.ts'

/**
 * A fake WebSocket standing in for a real network connection, driven manually by the test via
 * `emitOpen`/`emitMessage`/`emitClose`/`emitError` -- createSocket only touches `binaryType`,
 * `readyState`, `send`, `close`, and `addEventListener`, so that's all this needs to implement.
 */
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  binaryType = ''
  readyState = FakeWebSocket.CONNECTING
  sent: unknown[] = []
  private listeners: Record<string, Array<(event: unknown) => void>> = {}

  constructor(public url: string, public protocols?: string | string[]) {}

  addEventListener(type: string, handler: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(handler)
  }

  send(data: unknown): void { this.sent.push(data) }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners[type] ?? []) handler(event)
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
  }

  emitMessage(data: unknown): void { this.emit('message', { data }) }
  emitError(): void { this.emit('error', {}) }
}

let lastSocket: FakeWebSocket

beforeEach(() => {
  vi.stubGlobal('WebSocket', class extends FakeWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols)
      lastSocket = this
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createSocket', () => {
  it('resolves opened once the underlying WebSocket opens', async () => {
    const socket = createSocket('wss://example.test')
    lastSocket.emitOpen()
    await expect(socket.opened).resolves.toBeUndefined()
  })

  it('rejects opened if the WebSocket errors before opening', async () => {
    const socket = createSocket('wss://example.test')
    lastSocket.emitError()
    await expect(socket.opened).rejects.toThrow()
  })

  it('buffers an incoming message and makes it readable', async () => {
    const socket = createSocket('wss://example.test')
    lastSocket.emitOpen()
    await socket.opened

    lastSocket.emitMessage(new TextEncoder().encode('hello').buffer)

    const into = new Uint8Array(16)
    const n = socket.ops.read?.(socket.file, into, 0, 0)
    expect(n).toBe(5)
    expect(new TextDecoder().decode(into.subarray(0, 5))).toBe('hello')
  })

  it('reports EPOLLIN once data has arrived', async () => {
    const socket = createSocket('wss://example.test')
    lastSocket.emitOpen()
    await socket.opened

    expect((socket.ops.poll?.(socket.file) ?? 0) & EPOLLIN).toBe(0)
    lastSocket.emitMessage(new TextEncoder().encode('x').buffer)
    expect((socket.ops.poll?.(socket.file) ?? 0) & EPOLLIN).toBeTruthy()
  })

  it('reports EPOLLOUT once open and not yet closed', async () => {
    const socket = createSocket('wss://example.test')
    expect((socket.ops.poll?.(socket.file) ?? 0) & EPOLLOUT).toBe(0)
    lastSocket.emitOpen()
    await socket.opened
    expect((socket.ops.poll?.(socket.file) ?? 0) & EPOLLOUT).toBeTruthy()
  })

  it('sends a write through to the underlying WebSocket once open', async () => {
    const socket = createSocket('wss://example.test')
    lastSocket.emitOpen()
    await socket.opened

    const data = new TextEncoder().encode('ping')
    socket.ops.write?.(socket.file, data, 0)
    expect(lastSocket.sent).toEqual([data])
  })

  it('throws EAGAIN on a write before the connection has opened', () => {
    const socket = createSocket('wss://example.test')
    expect(() => socket.ops.write?.(socket.file, new Uint8Array([1]), 0)).toThrow()
  })

  it('throws ECONNRESET on a write after close', async () => {
    const socket = createSocket('wss://example.test')
    lastSocket.emitOpen()
    await socket.opened
    socket.close()
    expect(() => socket.ops.write?.(socket.file, new Uint8Array([1]), 0)).toThrow()
  })

  it('returns 0 (EOF) reading a closed, drained socket rather than blocking', async () => {
    const socket = createSocket('wss://example.test')
    lastSocket.emitOpen()
    await socket.opened
    socket.close()

    const into = new Uint8Array(16)
    const n = socket.ops.read?.(socket.file, into, 0, 0)
    expect(n).toBe(0)
  })
})
