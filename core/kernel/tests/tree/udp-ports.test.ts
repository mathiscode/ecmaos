import { describe, expect, it } from 'vitest'

import type { GatewayFlow } from '#lib/remote-gateway.ts'
import { bindUdpPort, FrameHeader, frameOf, udpPortAt } from '#lib/udp-ports.ts'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const bytes = (value: string) => new TextEncoder().encode(value)

/** The next addressed datagram the program would read */
async function received(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value } = await reader.read()
  const frame = value!
  return { from: `${frame[2]}.${frame[3]}.${frame[4]}.${frame[5]}:${(frame[6]! << 8) | frame[7]!}`, data: text(frame.slice(FrameHeader)) }
}

const noFlows = { open: () => Promise.reject(new Error('no gateway')) }

describe('bound UDP sockets', () => {
  it('claims a port once, picks an ephemeral one for 0, and releases it on close', () => {
    const a = bindUdpPort(6001, noFlows)!
    expect(bindUdpPort(6001, noFlows)).toBeUndefined()
    const free = bindUdpPort(0, noFlows)!
    expect(free.port).toBeGreaterThanOrEqual(49152)
    expect(udpPortAt(6001)).toBe(a)
    a.close()
    free.close()
    expect(udpPortAt(6001)).toBeUndefined()
    expect(bindUdpPort(6001, noFlows)).toBeDefined()
    udpPortAt(6001)!.close()
  })

  it('hands a datagram to the program naming its sender, and keeps each sender apart', async () => {
    const port = bindUdpPort(6002, noFlows)!
    const reader = port.rx.getReader()
    port.deliver('10.0.0.1', 4000, bytes('one'))
    port.deliver('10.0.0.2', 4001, bytes('two'))
    expect(await received(reader)).toEqual({ from: '10.0.0.1:4000', data: 'one' })
    expect(await received(reader)).toEqual({ from: '10.0.0.2:4001', data: 'two' })
    port.close()
  })

  it('answers a peer that came in through the gateway along the way it came, and only that peer', async () => {
    const port = bindUdpPort(6003, noFlows)!
    const replies: string[] = []
    port.hear('10.0.0.1:4000', data => replies.push(`a:${text(data)}`))
    port.hear('10.0.0.2:4001', data => replies.push(`b:${text(data)}`))
    const writer = port.tx.getWriter()
    await writer.write(frameOf('10.0.0.2', 4001, bytes('to b')))
    await writer.write(frameOf('10.0.0.1', 4000, bytes('to a')))
    expect(replies).toEqual(['b:to b', 'a:to a'])
    port.close()
  })

  it('reassembles a frame split across writes', async () => {
    const port = bindUdpPort(6004, noFlows)!
    const replies: string[] = []
    port.hear('10.0.0.1:4000', data => replies.push(text(data)))
    const frame = frameOf('10.0.0.1', 4000, bytes('whole'))
    const writer = port.tx.getWriter()
    await writer.write(frame.slice(0, 5))
    await writer.write(frame.slice(5))
    expect(replies).toEqual(['whole'])
    port.close()
  })

  it('delivers between two programs on this machine, from the sender\'s port', async () => {
    const server = bindUdpPort(6005, noFlows)!
    const client = bindUdpPort(6006, noFlows)!
    const reader = server.rx.getReader()
    await client.tx.getWriter().write(frameOf('127.0.0.1', 6005, bytes('hello')))
    expect(await received(reader)).toEqual({ from: '127.0.0.1:6006', data: 'hello' })
    server.close()
    client.close()
  })

  it('reaches other addresses through one gateway flow per destination, and brings replies back from that destination', async () => {
    const opened: string[] = []
    const sent: string[] = []
    let answer!: (frame: Uint8Array) => void
    const deps = {
      open: async (host: string, port: number): Promise<GatewayFlow> => {
        opened.push(`${host}:${port}`)
        return {
          address: host,
          rx: new ReadableStream<Uint8Array>({ start(controller) { answer = frame => controller.enqueue(frame) } }),
          tx: new WritableStream<Uint8Array>({ write(chunk) { sent.push(text(chunk.slice(2))) } }),
          close() { /* nothing to release */ }
        }
      }
    }
    const port = bindUdpPort(6007, deps)!
    const reader = port.rx.getReader()
    const writer = port.tx.getWriter()
    await writer.write(frameOf('93.184.216.34', 53, bytes('q1')))
    await writer.write(frameOf('93.184.216.34', 53, bytes('q2')))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(opened).toEqual(['93.184.216.34:53'])
    expect(sent).toEqual(['q1', 'q2'])
    const reply = bytes('answer')
    answer(new Uint8Array([0, reply.length, ...reply]))
    expect(await received(reader)).toEqual({ from: '93.184.216.34:53', data: 'answer' })
    port.close()
  })

  it('drops a datagram when no gateway is up instead of failing the program', async () => {
    const port = bindUdpPort(6008, noFlows)!
    await port.tx.getWriter().write(frameOf('93.184.216.34', 53, bytes('lost')))
    await new Promise(resolve => setTimeout(resolve, 20))
    port.close()
  })

  it('drops what arrives faster than the program reads', () => {
    const port = bindUdpPort(6009, noFlows)!
    for (let i = 0; i < 1000; i++) port.deliver('10.0.0.1', 1, bytes('x'))
    port.close()
  })
})
