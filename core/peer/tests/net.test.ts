import { describe, expect, it } from 'vitest'

import { Connection, memoryPair, NetChannel, openFlow, parseNetTarget, PeerError } from '../src/index.ts'

describe('net targets', () => {
  it('accepts a host and a port', () => {
    expect(parseNetTarget({ proto: 'tcp', host: 'example.com', port: 443 })).toEqual({ proto: 'tcp', host: 'example.com', port: 443 })
  })

  it('refuses what is not a tcp target with a host and a valid port', () => {
    for (const bad of [null, 'x', [1], { proto: 'udp', host: 'a', port: 1 }, { proto: 'tcp', host: '', port: 1 }, { proto: 'tcp', host: 'a b', port: 1 },
      { proto: 'tcp', host: 'a/b', port: 1 }, { proto: 'tcp', host: 'a'.repeat(254), port: 1 }, { proto: 'tcp', host: 'a', port: 0 },
      { proto: 'tcp', host: 'a', port: 70000 }, { proto: 'tcp', host: 'a', port: 1.5 }, { proto: 'tcp', host: 'a', port: '80' }]) {
      expect(() => parseNetTarget(bad as never), JSON.stringify(bad)).toThrow(PeerError)
    }
  })
})

describe('opening a flow', () => {
  it('resolves when the host says it is connected, carrying the address', async () => {
    const [a, b] = memoryPair()
    const guest = new Connection(a, { role: 'client' })
    const host = new Connection(b, { role: 'server' })
    host.accept(NetChannel, channel => { channel.send({ op: 'connected', address: '203.0.113.9', port: 80 }) })
    const flow = await openFlow(guest, { proto: 'tcp', host: 'example.com', port: 80 })
    expect(flow.address).toBe('203.0.113.9')
    expect(flow.port).toBe(80)
    guest.close()
  })

  it('rejects with the host\'s reason when it refuses', async () => {
    const [a, b] = memoryPair()
    const guest = new Connection(a, { role: 'client' })
    const host = new Connection(b, { role: 'server' })
    host.accept(NetChannel, () => { throw new PeerError('refused', 'not today') })
    await expect(openFlow(guest, { proto: 'tcp', host: 'example.com', port: 80 })).rejects.toThrow('not today')
    guest.close()
  })
})
