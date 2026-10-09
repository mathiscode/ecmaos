import { describe, expect, it } from 'vitest'

import { Connection, datagram, datagramOf, MaxDatagram, memoryPair, NetChannel, openFlow, parseNetLookup, parseNetTarget, parseNetListen, parseNetAccept, PeerError, resolveName } from '../src/index.ts'

describe('net targets', () => {
  it('accepts a host and a port', () => {
    expect(parseNetTarget({ proto: 'tcp', host: 'example.com', port: 443 })).toEqual({ proto: 'tcp', host: 'example.com', port: 443 })
  })

  it('refuses what is not a tcp target with a host and a valid port', () => {
    for (const bad of [null, 'x', [1], { proto: 'icmp', host: 'a', port: 1 }, { proto: 'tcp', host: '', port: 1 }, { proto: 'tcp', host: 'a b', port: 1 },
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

describe('lookups', () => {
  it('reads a name with an optional family, defaulting to IPv4', () => {
    expect(parseNetLookup({ proto: 'dns', name: 'example.com' })).toEqual({ proto: 'dns', name: 'example.com', family: 4 })
    expect(parseNetLookup({ proto: 'dns', name: 'example.com', family: 6 }).family).toBe(6)
  })

  it('refuses anything else', () => {
    for (const bad of [null, 'x', [1], { proto: 'tcp', name: 'a' }, { proto: 'dns', name: '' }, { proto: 'dns', name: 'a b' },
      { proto: 'dns', name: 'a'.repeat(254) }, { proto: 'dns', name: 'a', family: 5 }, { proto: 'dns', name: 7 }]) {
      expect(() => parseNetLookup(bad as never), JSON.stringify(bad)).toThrow(PeerError)
    }
  })

  it('resolveName returns the addresses the host sends and closes', async () => {
    const [a, b] = memoryPair()
    const guest = new Connection(a, { role: 'client' })
    const host = new Connection(b, { role: 'server' })
    host.accept(NetChannel, channel => { channel.send({ op: 'resolved', addresses: ['203.0.113.9', 'x'] }); channel.close() })
    expect(await resolveName(guest, 'example.com')).toEqual(['203.0.113.9', 'x'])
    guest.close()
  })

  it('resolveName rejects with the host\'s reason', async () => {
    const [a, b] = memoryPair()
    const guest = new Connection(a, { role: 'client' })
    const host = new Connection(b, { role: 'server' })
    host.accept(NetChannel, () => { throw new PeerError('refused', 'no such name') })
    await expect(resolveName(guest, 'example.com')).rejects.toThrow('no such name')
    guest.close()
  })
})

describe('datagrams', () => {
  it('accepts a udp target', () => {
    expect(parseNetTarget({ proto: 'udp', host: 'example.com', port: 53 })).toEqual({ proto: 'udp', host: 'example.com', port: 53 })
  })

  it('wraps bytes as a control message and reads them back, refusing anything else', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(datagramOf(datagram(bytes))).toEqual(bytes)
    for (const other of [null, 'x', [1], { op: 'eof' }, { op: 'd' }, { op: 'd', data: 'text' }, { op: 'd', data: new Uint8Array(MaxDatagram + 1) }]) {
      expect(datagramOf(other as never), JSON.stringify(other)).toBeUndefined()
    }
  })
})

describe('listen requests', () => {
  it('defaults the host port to the guest port and checks both', () => {
    expect(parseNetListen({ proto: 'listen', port: 3000 })).toEqual({ proto: 'listen', port: 3000, as: 3000 })
    expect(parseNetListen({ proto: 'listen', port: 3000, as: 8080 }).as).toBe(8080)
    for (const bad of [{ proto: 'listen', port: 0 }, { proto: 'listen', port: 70000 }, { proto: 'listen', port: 1.5 }, { proto: 'listen', port: 80, as: 0 }, { proto: 'listen', port: '80' }, null, [], new Uint8Array(1)]) {
      expect(() => parseNetListen(bad as never), JSON.stringify(bad)).toThrow(PeerError)
    }
  })

  it('checks an announced connection', () => {
    expect(parseNetAccept({ proto: 'accept', id: 3, peer: '203.0.113.5:4000' })).toEqual({ proto: 'accept', id: 3, peer: '203.0.113.5:4000' })
    for (const bad of [{ proto: 'accept', id: -1, peer: 'x' }, { proto: 'accept', id: 1, peer: 5 }, { proto: 'accept', id: 'a', peer: 'x' }, { proto: 'tcp', id: 1, peer: 'x' }, null]) {
      expect(() => parseNetAccept(bad as never), JSON.stringify(bad)).toThrow(PeerError)
    }
  })
})
