import { describe, expect, it } from 'vitest'
import { Connection, memoryPair, MessageStream } from '../src/index.ts'
import type { Value } from '../src/index.ts'

async function pair(window?: number) {
  const [a, b] = memoryPair()
  const client = new Connection(a, { role: 'client' })
  const server = new Connection(b, { role: 'server', window })
  const received: Promise<MessageStream> = new Promise(resolve => server.accept('m', channel => { resolve(new MessageStream(channel, { maxMessage: 4 << 20 })) }))
  const channel = await client.open('m')
  return { sender: new MessageStream(channel), receiver: await received, client, server }
}

describe('MessageStream', () => {
  it('delivers messages in order, small and large, through a small window', async () => {
    const { sender, receiver } = await pair(1024)
    const got: Value[] = []
    receiver.onMessage = value => got.push(value)
    const big = Uint8Array.from({ length: 3 << 20 }, (_, index) => index % 253)
    await Promise.all([sender.send({ n: 1 }), sender.send({ big }), sender.send('last')])
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(got).toHaveLength(3)
    expect(got[0]).toEqual({ n: 1 })
    expect(Buffer.compare((got[1] as { big: Uint8Array }).big, big)).toBe(0)
    expect(got[2]).toBe('last')
  })

  it('refuses to send, and to accept, a message past the limit', async () => {
    const { sender, receiver, server } = await pair()
    await expect(new MessageStream(sender.channel, { maxMessage: 10 }).send(new Uint8Array(100))).rejects.toMatchObject({ code: 'limit' })
    // a sender that ignores its own limit is cut off by the receiver
    await sender.send(new Uint8Array(5 << 20)).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(receiver.closed).toBe(true)
    expect(server.closed).toBe(false)
  })

  it('can send large messages and accept only small ones', async () => {
    const [a, b] = memoryPair()
    const client = new Connection(a, { role: 'client' })
    const server = new Connection(b, { role: 'server' })
    const received: Promise<MessageStream> = new Promise(resolve => server.accept('m', channel => { resolve(new MessageStream(channel, { maxReceive: 1000 })) }))
    const channel = await client.open('m')
    const open = new MessageStream(channel)
    const limited = await received
    const got: Value[] = []
    open.onMessage = value => got.push(value)
    // the side that accepts little can still send a lot
    await limited.send(new Uint8Array(200_000))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(got).toHaveLength(1)
    expect((got[0] as Uint8Array).length).toBe(200_000)
    // and refuses a large message from the other side
    await open.send(new Uint8Array(200_000)).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(limited.closed).toBe(true)
  })

  it('a garbled message closes the channel, not the connection', async () => {
    const { sender, receiver, client } = await pair()
    await sender.channel.write(Uint8Array.from([0, 0, 0, 2, 99, 99]))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(receiver.closed).toBe(true)
    expect(client.closed).toBe(false)
  })
})
