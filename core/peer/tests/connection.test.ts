import { describe, expect, it } from 'vitest'
import { Connection, memoryPair, PeerError, ProtocolMax, webSocketTransport, Writer, writeValue } from '../src/index.ts'
import type { Channel, ConnectionOptions, WebSocketLike } from '../src/index.ts'

function link(client: Partial<ConnectionOptions> = {}, server: Partial<ConnectionOptions> = {}, filter?: Parameters<typeof memoryPair>[0]) {
  const [a, b] = memoryPair(filter)
  const left = new Connection(a, { role: 'client', ...client })
  const right = new Connection(b, { role: 'server', ...server })
  return { left, right, a, b }
}

const bytes = (...values: number[]) => Uint8Array.from(values)
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

describe('handshake', () => {
  it('negotiates a version and exchanges meta', async () => {
    const { left, right } = link({ meta: { name: 'browser' } }, { meta: { name: 'host' } })
    expect(await left.ready).toBe(ProtocolMax)
    expect(await right.ready).toBe(ProtocolMax)
    expect(left.peerMeta).toEqual({ name: 'host' })
    expect(right.peerMeta).toEqual({ name: 'browser' })
  })

  it('fails with `version` when the ranges do not overlap, on both sides', async () => {
    const [a, b] = memoryPair()
    const left = new Connection(a, { role: 'client' })
    // a peer from the future: speaks only versions 50 to 60
    const hello = new Writer()
    hello.u8(1); hello.varuint(0); writeValue(hello, { min: 50, max: 60, meta: {} })
    b.onMessage = () => {}
    b.send(hello.finish())
    await expect(left.ready).rejects.toMatchObject({ code: 'version' })
    expect(await left.done).toMatchObject({ code: 'version' })
  })

  it('fails if the first frame is not a hello', async () => {
    const [a, b] = memoryPair()
    const left = new Connection(a, { role: 'client' })
    b.onMessage = () => {}
    b.send(Uint8Array.from([6, 1, 1, 2, 3]))
    await expect(left.ready).rejects.toMatchObject({ code: 'protocol' })
  })

  it('times out waiting for a hello', async () => {
    const [a] = memoryPair()
    const left = new Connection(a, { role: 'client', helloTimeout: 20 })
    await expect(left.ready).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('channels', () => {
  it('opens a channel, passes params and exchanges data and messages both ways', async () => {
    const { left, right } = link()
    const received: Uint8Array[] = []
    right.accept('echo', channel => {
      expect(channel.params).toEqual({ greeting: 'hi' })
      channel.onData = data => { received.push(data); void channel.write(data) }
      channel.onMessage = value => channel.send({ echoed: value })
    })
    const channel = await left.open('echo', { params: { greeting: 'hi' } })
    const back: Uint8Array[] = []
    const messages: unknown[] = []
    channel.onData = data => back.push(data)
    channel.onMessage = value => messages.push(value)
    await channel.write(bytes(1, 2, 3))
    channel.send('ping')
    await tick()
    expect([...received[0]!]).toEqual([1, 2, 3])
    expect([...back[0]!]).toEqual([1, 2, 3])
    expect(messages).toEqual([{ echoed: 'ping' }])
  })

  it('either side can open channels and ids never collide', async () => {
    const { left, right } = link()
    const seen: number[] = []
    left.accept('x', c => { seen.push(c.id) })
    right.accept('x', c => { seen.push(c.id) })
    const channels = await Promise.all([left.open('x'), right.open('x'), left.open('x'), right.open('x')])
    expect(new Set(channels.map(c => c.id)).size).toBe(4)
    expect(channels[0]!.id % 2).toBe(1)
    expect(channels[1]!.id % 2).toBe(0)
    await tick()
    expect(seen.length).toBe(4)
  })

  it('refuses an unknown kind with `unsupported`', async () => {
    const { left } = link()
    await expect(left.open('nothing')).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('a handler that throws refuses the channel with its message', async () => {
    const { left, right } = link()
    right.accept('private', () => { throw new PeerError('auth', 'not allowed') })
    right.accept('async', async () => { throw new Error('boom') })
    const first = await left.open('private')
    expect(await first.done).toMatchObject({ code: 'auth', message: 'not allowed' })
    const second = await left.open('async')
    expect(await second.done).toMatchObject({ code: 'refused', message: 'boom' })
  })

  it('data written before the reader attaches is kept in order', async () => {
    const { left, right } = link()
    let server!: Channel
    right.accept('x', channel => { server = channel })
    const channel = await left.open('x')
    await channel.write(bytes(1))
    await channel.write(bytes(2))
    channel.send('m1')
    await tick()
    const got: number[] = []
    server.onData = data => got.push(...data)
    const messages: unknown[] = []
    server.onMessage = value => messages.push(value)
    expect(got).toEqual([1, 2])
    expect(messages).toEqual(['m1'])
  })

  it('read() and the async iterator end when the channel closes', async () => {
    const { left, right } = link()
    right.accept('x', async channel => {
      await channel.write(bytes(1, 2))
      await channel.write(bytes(3))
      channel.close()
    })
    const channel = await left.open('x')
    const got: number[] = []
    for await (const chunk of channel) got.push(...chunk)
    expect(got).toEqual([1, 2, 3])
    expect(await channel.done).toBeUndefined()
  })

  it('closing a channel ends both sides and fails pending writes', async () => {
    const { left, right } = link()
    let server!: Channel
    right.accept('x', channel => { server = channel })
    const channel = await left.open('x', { window: 8 })
    // the server's window is the connection default; the client's is 8, so the server can only send 8 unread bytes
    await tick()
    const writing = server.write(new Uint8Array(100))
    await tick()
    channel.close()
    await expect(writing).rejects.toMatchObject({ code: 'closed' })
    await tick()
    expect(server.closed).toBe(true)
    expect(() => channel.send(1)).toThrow(PeerError)
  })

  it('carries an error across a close', async () => {
    const { left, right } = link()
    let server!: Channel
    right.accept('x', channel => { server = channel })
    const channel = await left.open('x')
    await tick()
    server.close(new PeerError('limit', 'too big'))
    expect(await channel.done).toMatchObject({ code: 'limit', message: 'too big' })
  })

  it('data in flight for a channel just closed is ignored, not fatal', async () => {
    const { left, right } = link()
    let server!: Channel
    right.accept('x', channel => { server = channel })
    const channel = await left.open('x')
    await tick()
    void server.write(bytes(1, 2, 3))
    channel.close()
    await tick()
    expect(left.closed).toBe(false)
    expect(right.closed).toBe(false)
  })

  it('limits the number of channels', async () => {
    const { left, right } = link({}, { maxChannels: 2 })
    right.accept('x', () => {})
    await left.open('x'); await left.open('x')
    await expect(left.open('x')).rejects.toMatchObject({ code: 'limit' })
  })

  it('times out when the other side never accepts', async () => {
    const [a, b] = memoryPair()
    const left = new Connection(a, { role: 'client' })
    const right = new Connection(b, { role: 'server' })
    await left.ready
    b.onMessage = data => { if (data[0] !== 4) right['_onMessage'](data) } // swallow open frames
    await expect(left.open('x', { timeout: 20 })).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('flow control', () => {
  it('a writer waits for the reader: no more than the window is ever outstanding', async () => {
    const { left, right } = link({}, {}, undefined)
    let server!: Channel
    right.accept('stream', channel => { channel.manualCredit = true; server = channel })
    const channel = await left.open('stream', { window: 1024 })
    await tick()
    const held: Uint8Array[] = []
    server.onData = data => held.push(data)

    // the server's window is the default (256 KiB), so the client can write that much before it must wait
    const total = (256 << 10) * 2
    let finished = false
    const writing = channel.write(new Uint8Array(total)).then(() => { finished = true })
    await tick()
    const sent = held.reduce((sum, chunk) => sum + chunk.length, 0)
    expect(sent).toBe(256 << 10)
    expect(finished).toBe(false)
    expect(server.outstanding).toBe(256 << 10)

    // the reader consumes; credit flows back; the rest goes
    server.grant(sent)
    await tick()
    expect(held.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(total)
    server.grant(total - sent)
    await writing
    expect(finished).toBe(true)
  })

  it('automatic credit lets a fast reader stream far more than the window', async () => {
    const { left, right } = link()
    let received = 0
    right.accept('sink', channel => { channel.onData = data => { received += data.length } })
    const channel = await left.open('sink')
    const size = 5 << 20
    const payload = new Uint8Array(size).map((_, index) => index % 251)
    await channel.write(payload)
    await tick()
    expect(received).toBe(size)
  })

  it('preserves the bytes of a large transfer', async () => {
    const { left, right } = link()
    const parts: Uint8Array[] = []
    right.accept('sink', channel => { channel.onData = data => parts.push(data.slice()) })
    const channel = await left.open('sink')
    const payload = Uint8Array.from({ length: 1_000_003 }, (_, index) => (index * 7) % 256)
    await channel.write(payload)
    await tick()
    const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) { joined.set(part, offset); offset += part.length }
    expect(joined.length).toBe(payload.length)
    expect(Buffer.compare(joined, payload)).toBe(0)
  })

  it('a peer that sends past its credit is cut off with `protocol`', async () => {
    const [a, b] = memoryPair()
    const left = new Connection(a, { role: 'client', window: 16 })
    const right = new Connection(b, { role: 'server' })
    right.accept('x', () => {})
    await left.ready
    left.accept('x', channel => { channel.manualCredit = true })
    const channel = await right.open('x', { window: 16 })
    await tick()
    // bypass the credit check on the sending side by writing a frame by hand
    const frame = new Writer()
    frame.u8(6); frame.varuint(channel.id); frame.raw(new Uint8Array(64))
    b.send(frame.finish())
    expect(await left.done).toMatchObject({ code: 'protocol' })
    expect(await right.done).toMatchObject({ code: 'protocol' })
  })
})

describe('connection', () => {
  it('rejects oversized frames', async () => {
    const { left, right } = link({}, { maxFrame: 1024 })
    right.accept('x', () => {})
    const channel = await left.open('x')
    await tick()
    // the client's own maxFrame is large, so the write is allowed to build a big frame; the server refuses it
    left['_transport'].send(Uint8Array.from([6, channel.id, ...new Array(4096).fill(0)]))
    expect(await right.done).toMatchObject({ code: 'limit' })
  })

  it('chunks writes to maxFrame', async () => {
    const { left, right, a } = link({ maxFrame: 100 }, {})
    right.accept('x', channel => { channel.onData = () => {} })
    const channel = await left.open('x')
    const before = a.sent.messages
    await channel.write(new Uint8Array(1000))
    expect(a.sent.messages - before).toBe(10)
  })

  it('ping measures a round trip, and keepalive drops a dead link', async () => {
    const { left } = link()
    expect(await left.ping()).toBeGreaterThanOrEqual(0)

    const [a, b] = memoryPair({ filter: (data, from) => from === 'a' || data[0] === 1 })
    const alive = new Connection(a, { role: 'client', keepalive: { interval: 10, timeout: 20 } })
    new Connection(b, { role: 'server' })
    // the server's pongs are dropped by the filter, so the keepalive fires
    expect(await alive.done).toMatchObject({ code: 'timeout' })
  })

  it('closing ends channels and pending opens on both sides', async () => {
    const { left, right } = link()
    let server!: Channel
    right.accept('x', channel => { server = channel })
    const channel = await left.open('x')
    await tick()
    left.close()
    expect(await right.done).toBeUndefined()
    expect(channel.closed).toBe(true)
    expect(server.closed).toBe(true)
    await expect(left.open('x')).rejects.toMatchObject({ code: 'closed' })
  })

  it('a transport that drops ends everything', async () => {
    const { left, right, a } = link()
    right.accept('x', () => {})
    const channel = await left.open('x')
    a.close()
    await left.done
    expect(channel.closed).toBe(true)
    expect(left.closed).toBe(true)
  })

  it('survives garbage frames without throwing out of the event handler', async () => {
    let seed = 99
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
    for (let run = 0; run < 300; run++) {
      const [a, b] = memoryPair()
      const left = new Connection(a, { role: 'client' })
      const right = new Connection(b, { role: 'server' })
      right.accept('x', () => {})
      await left.ready
      const garbage = Uint8Array.from({ length: 1 + next() % 30 }, () => next() % 12)
      b.send(garbage)
      await tick()
      // either the garbage was harmless or the connection failed cleanly; it never hangs or throws
      if (left.closed) expect(await left.done).toBeInstanceOf(PeerError)
      left.close(); right.close()
    }
  })
})

describe('webSocketTransport', () => {
  function fakeSocket() {
    const listeners: Record<string, Array<(event?: never) => void>> = {}
    const socket = {
      binaryType: 'blob', readyState: 1,
      sent: [] as Uint8Array[],
      send(data: Uint8Array) { this.sent.push(data) },
      close() { for (const fn of listeners.close ?? []) fn() },
      addEventListener(type: string, fn: (event?: never) => void) { (listeners[type] ??= []).push(fn) },
      emit(type: string, event?: unknown) { for (const fn of listeners[type] ?? []) fn(event as never) }
    }
    return socket
  }

  it('delivers binary messages, ends on close and refuses text', () => {
    const socket = fakeSocket()
    const transport = webSocketTransport(socket as unknown as WebSocketLike)
    expect(socket.binaryType).toBe('arraybuffer')
    const got: number[][] = []
    transport.onMessage = data => got.push([...data])
    let closed: Error | undefined | 'no' = 'no'
    transport.onClose = error => { closed = error }
    socket.emit('message', { data: Uint8Array.from([1, 2]).buffer })
    socket.emit('message', { data: Uint8Array.from([3]) })
    expect(got).toEqual([[1, 2], [3]])
    socket.emit('message', { data: 'text' })
    expect(closed).toBeInstanceOf(Error)
    transport.send(Uint8Array.from([9]))
    expect(socket.sent.length).toBe(1)
  })
})
