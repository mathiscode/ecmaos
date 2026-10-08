import { describe, expect, it } from 'vitest'

import { Connection, memoryPair, NetChannel, openFlow, PeerError } from '@ecmaos/peer'

import { errnoFor, GatewayFailure, openGatewayFlow, streamsOf } from '#lib/remote-gateway.ts'
import type { Kernel } from '#kernel.ts'

describe('what a program sees when the gateway cannot connect', () => {
  it('maps the host\'s reason to the errno a connect() would give', () => {
    const cases: Array<[PeerError, string]> = [
      [new PeerError('refused', '93.184.216.34:80: ECONNREFUSED'), 'ECONNREFUSED'],
      [new PeerError('refused', '93.184.216.34:80: EHOSTUNREACH'), 'EHOSTUNREACH'],
      [new PeerError('refused', '93.184.216.34:80: ETIMEDOUT'), 'ETIMEDOUT'],
      [new PeerError('refused', '10.0.0.5 is 10.0.0.5, which this gateway does not reach'), 'EACCES'],
      [new PeerError('refused', 'root may not use this gateway'), 'EACCES'],
      [new PeerError('timeout', 'idle'), 'ETIMEDOUT'],
      [new PeerError('limit', 'too many flows (32)'), 'ENOBUFS']
    ]
    for (const [error, errno] of cases) expect(errnoFor(error).errno, error.message).toBe(errno)
    expect(errnoFor(new Error('boom')).errno).toBe('ECONNREFUSED')
  })

  it('is ENETUNREACH when no gateway is up', async () => {
    const error = await openGatewayFlow({} as Kernel, '93.184.216.34', 80).catch(error => error)
    expect(error).toBeInstanceOf(GatewayFailure)
    expect(error.errno).toBe('ENETUNREACH')
  })
})

describe('a flow as streams', () => {
  async function pair(serve: (channel: import('@ecmaos/peer').Channel) => void) {
    const [a, b] = memoryPair()
    const guest = new Connection(a, { role: 'client' })
    const host = new Connection(b, { role: 'server' })
    host.accept(NetChannel, channel => { channel.send({ op: 'connected', address: '203.0.113.9', port: 80 }); serve(channel) })
    const flow = await openFlow(guest, { proto: 'tcp', host: 'example.com', port: 80 })
    return { guest, host, flow, ...streamsOf(flow.channel) }
  }

  it('carries bytes both ways and half-closes: ending the write side says eof but the read side keeps going', async () => {
    const received: string[] = []
    const { guest, rx, tx } = await pair(channel => {
      channel.onData = data => { received.push(new TextDecoder().decode(data)); void channel.write(new TextEncoder().encode(new TextDecoder().decode(data).toUpperCase())) }
      channel.onMessage = message => { if ((message as { op?: string }).op === 'eof') { void channel.write(new TextEncoder().encode('!')).then(() => channel.send({ op: 'eof' })) } }
    })
    const writer = tx.getWriter()
    await writer.write(new TextEncoder().encode('hello'))
    await writer.close()
    const reader = rx.getReader()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    expect(received).toEqual(['hello'])
    expect(text).toBe('HELLO!')
    guest.close()
  })

  it('moves a transfer much bigger than the credit window, in order', async () => {
    const size = 3 * 1024 * 1024
    const { guest, rx } = await pair(channel => {
      void (async () => {
        const chunk = new Uint8Array(32768)
        for (let sent = 0; sent < size; sent += chunk.length) { chunk.fill((sent / chunk.length) & 0xff); await channel.write(chunk.slice()) }
        channel.send({ op: 'eof' })
      })()
    })
    const reader = rx.getReader()
    let total = 0
    let wrong = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.every(byte => byte === value[0])) { if (value[0] !== ((total / 32768) & 0xff)) wrong++ } else wrong++
      total += value.length
    }
    expect(total).toBe(size)
    expect(wrong).toBe(0)
    guest.close()
  })

  it('ends the read side when the host closes the channel', async () => {
    const { guest, rx } = await pair(channel => { setTimeout(() => channel.close(), 10) })
    const { done } = await rx.getReader().read()
    expect(done).toBe(true)
    guest.close()
  })
})
