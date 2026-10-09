import { afterEach, describe, expect, it } from 'vitest'
import dgram from 'node:dgram'
import net from 'node:net'
import type { Server } from 'node:net'

import { Connection, datagram, datagramOf, memoryPair, NetChannel, openFlow, openListener, parseNetAccept, peerDatagram, peerDatagramOf, PeerError, resolveName } from '@ecmaos/peer'
import type { Channel } from '@ecmaos/peer'

import { Gateway, parseRule } from '../src/gateway.ts'
import type { GatewayOptions } from '../src/gateway.ts'

const servers: Server[] = []
const connections: Connection[] = []

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  for (const server of servers.splice(0)) server.close()
})

/** A TCP server on loopback: echoes what it gets, upper-cased, and says "bye" when its peer ends */
async function echo() {
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', chunk => socket.write(chunk.toString().toUpperCase()))
    socket.on('end', () => socket.end('bye'))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}

/** A guest and a host over an in-memory link, the host serving `net` as `user` */
function link(options: GatewayOptions = {}, user = 'root') {
  const log: string[] = []
  const gateway = new Gateway({ log: text => log.push(text), ...options })
  const [a, b] = memoryPair()
  const guest = new Connection(a, { role: 'client' })
  const host = new Connection(b, { role: 'server' })
  connections.push(guest, host)
  gateway.attach(host, user)
  return { gateway, guest, host, log }
}

const reach = (guest: Connection, host: string, port: number) => openFlow(guest, { proto: 'tcp', host, port }, { timeout: 2000 })
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** What the gateway would say to `host:port` as a refusal, or `undefined` if it lets it through to connect */
async function refusal(options: GatewayOptions, host: string, port: number) {
  try { await new Gateway(options).check(host, port); return undefined } catch (error) { return (error as Error).message }
}

describe('a flow through the gateway', () => {
  it('connects, carries bytes both ways, and reports the address it used', async () => {
    const port = await echo()
    const { guest } = link({ allow: [parseRule('127.0.0.0/8')] })
    const flow = await reach(guest, '127.0.0.1', port)
    expect(flow.address).toBe('127.0.0.1')
    await flow.channel.write(new TextEncoder().encode('hello'))
    const reply = await flow.channel.read()
    expect(text(reply!)).toBe('HELLO')
  })

  it('half-close: saying eof ends the sending direction and the other still arrives', async () => {
    const port = await echo()
    const { guest } = link({ allow: [parseRule('127.0.0.0/8')] })
    const { channel } = await reach(guest, '127.0.0.1', port)
    const messages: unknown[] = []
    channel.onMessage = message => messages.push(message)
    channel.send({ op: 'eof' })
    const parts: string[] = []
    for await (const chunk of channel) parts.push(text(chunk))
    expect(parts.join('')).toBe('bye')
    expect(messages).toContainEqual({ op: 'eof' })
  })

  it('carries a large transfer in order', async () => {
    const port = await echo()
    const { guest } = link({ allow: [parseRule('127.0.0.0/8')] })
    const { channel } = await reach(guest, '127.0.0.1', port)
    const size = 2_000_000
    const data = new Uint8Array(size).fill(0x61)
    void channel.write(data)
    let got = 0
    let wrong = 0
    while (got < size) {
      const chunk = await channel.read()
      if (!chunk) break
      for (const byte of chunk) if (byte !== 0x41) wrong++
      got += chunk.length
    }
    expect(got).toBe(size)
    expect(wrong).toBe(0)
  }, 30000)

  it('refuses when nothing is listening, with the reason', async () => {
    const closed = net.createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as net.AddressInfo).port
    await new Promise<void>(resolve => closed.close(() => resolve()))
    const { guest } = link({ allow: [parseRule('127.0.0.0/8')] })
    await expect(reach(guest, '127.0.0.1', port)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('logs who went where, and the bytes at the end', async () => {
    const port = await echo()
    const { guest, log } = link({ allow: [parseRule('127.0.0.0/8')] })
    const { channel } = await reach(guest, '127.0.0.1', port)
    await channel.write(new TextEncoder().encode('abc'))
    await channel.read()
    channel.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(log[0]).toBe(`root -> 127.0.0.1:${port} (127.0.0.1) opened`)
    expect(log.at(-1)).toMatch(new RegExp(`root -> 127\\.0\\.0\\.1:${port} closed \\(3 bytes out, 3 in\\)`))
  })
})

describe('who and how many', () => {
  it('only the listed users may use it', async () => {
    const { guest } = link({}, 'alice')
    await expect(reach(guest, 'example.com', 80)).rejects.toThrow(/alice may not use this gateway/)
    const open = link({ users: ['alice'], resolve: async () => ['93.184.216.34'], connect: () => { throw new Error('not reached') } }, 'alice')
    await expect(reach(open.guest, 'example.com', 80)).rejects.not.toThrow(/may not use/)
  })

  it('refuses a flow past the limit and takes one again when another ends', async () => {
    const port = await echo()
    const { guest } = link({ allow: [parseRule('127.0.0.0/8')], maxFlows: 2 })
    const one = await reach(guest, '127.0.0.1', port)
    await reach(guest, '127.0.0.1', port)
    await expect(reach(guest, '127.0.0.1', port)).rejects.toThrow(/too many flows/)
    one.channel.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(reach(guest, '127.0.0.1', port)).resolves.toBeTruthy()
  })

  it('ends a flow that has been idle too long', async () => {
    const port = await echo()
    const { guest } = link({ allow: [parseRule('127.0.0.0/8')], idleMs: 80 })
    const { channel } = await reach(guest, '127.0.0.1', port)
    const error = await channel.done
    expect(error?.code).toBe('timeout')
  })

  it('does not accept a channel kind it was not given a handler for', async () => {
    const [a, b] = memoryPair()
    const guest = new Connection(a, { role: 'client' })
    const host = new Connection(b, { role: 'server' })
    connections.push(guest, host)
    await expect(guest.open(NetChannel, { params: { proto: 'tcp', host: 'x', port: 1 }, timeout: 500 })).rejects.toBeInstanceOf(PeerError)
  })
})

describe('what the gateway will not reach', () => {
  const public1 = async () => ['93.184.216.34']

  it('refuses this host and its neighbours by default, by address and by a name that points there', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '0.0.0.0']) {
      expect(await refusal({}, address, 80), address).toMatch(/does not reach/)
    }
    expect(await refusal({ resolve: async () => ['127.0.0.1'] }, 'localhost', 80)).toMatch(/localhost is 127\.0\.0\.1/)
    expect(await refusal({ resolve: async () => ['10.0.0.5'] }, 'internal.example', 80)).toMatch(/does not reach/)
  })

  it('refuses an IPv4 address written as IPv6', async () => {
    expect(await refusal({}, '::ffff:127.0.0.1', 80)).toMatch(/does not reach/)
    expect(await refusal({}, '::ffff:169.254.169.254', 80)).toMatch(/does not reach/)
  })

  it('checks every address a name resolves to, so one public answer does not hide a private one', async () => {
    expect(await refusal({ resolve: async () => ['93.184.216.34', '10.0.0.5'] }, 'rebind.example', 80)).toMatch(/does not reach/)
  })

  it('lets a public name through, and connects to the address it checked', async () => {
    expect(await refusal({ resolve: public1 }, 'example.com', 443)).toBeUndefined()
    expect(await new Gateway({ resolve: public1 }).check('Example.COM.', 443)).toBe('93.184.216.34')
  })

  it('a private address needs a rule for the address; a name rule does not open it', async () => {
    const via = (rule: string) => ({ resolve: async () => ['10.0.0.5'], allow: [parseRule(rule)] })
    expect(await refusal(via('10.0.0.0/8'), 'internal.example', 80)).toBeUndefined()
    expect(await refusal(via('10.0.0.5'), 'internal.example', 80)).toBeUndefined()
    expect(await refusal(via('internal.example'), 'internal.example', 80)).toMatch(/does not reach/)
    expect(await refusal(via('10.0.0.0/8:443'), 'internal.example', 80)).toMatch(/does not reach/)
  })

  it('with allow rules, only what they match is reachable', async () => {
    const options = { resolve: public1, allow: [parseRule('*.example.com:80,443')] }
    expect(await refusal(options, 'www.example.com', 443)).toBeUndefined()
    expect(await refusal(options, 'www.example.com', 22)).toMatch(/not allowed/)
    expect(await refusal(options, 'example.org', 443)).toMatch(/not allowed/)
  })

  it('a deny rule wins over everything, including an allow that matches', async () => {
    const options = { resolve: public1, allow: [parseRule('*.example.com')], deny: [parseRule('bad.example.com'), parseRule('93.184.216.0/24:25')] }
    expect(await refusal(options, 'bad.example.com', 80)).toMatch(/denied by the gateway \(bad\.example\.com\)/)
    expect(await refusal(options, 'ok.example.com', 25)).toMatch(/denied/)
    expect(await refusal(options, 'ok.example.com', 80)).toBeUndefined()
  })

  it('refuses a name it cannot resolve', async () => {
    expect(await refusal({ resolve: async () => { throw new Error('ENOTFOUND') } }, 'nope.invalid', 80)).toMatch(/could not resolve/)
  })

  it('refuses a malformed target before doing anything', async () => {
    const { guest } = link({})
    await expect(guest.open(NetChannel, { params: { proto: 'tcp', host: 'a b', port: 80 }, timeout: 500 }).then(channel => channel.done.then(error => { throw error }))).rejects.toThrow(/bad host name/)
    await expect(guest.open(NetChannel, { params: { proto: 'tcp', host: 'example.com', port: 99999 }, timeout: 500 }).then(channel => channel.done.then(error => { throw error }))).rejects.toThrow(/bad port/)
  })
})

describe('rules', () => {
  it('parse names, addresses, networks and port lists, and reject nonsense', () => {
    expect(parseRule('example.com').name!.test('example.com')).toBe(true)
    expect(parseRule('*.example.com').name!.test('a.example.com')).toBe(true)
    expect(parseRule('*.example.com').name!.test('example.com')).toBe(false)
    expect(parseRule('example.com:80,8000-8100').ports).toEqual([[80, 80], [8000, 8100]])
    expect(parseRule('10.0.0.0/8').addresses!.check('10.9.9.9')).toBe(true)
    expect(parseRule('[fd00::/8]:443').addresses!.check('fd12::1', 'ipv6')).toBe(true)
    expect(parseRule('[fd00::/8]:443').ports).toEqual([[443, 443]])
    expect(parseRule('fd00::1').addresses!.check('fd00::1', 'ipv6')).toBe(true)
    for (const bad of ['', '10.0.0.0/40', 'a b', 'example.com:99999', 'example.com:9-1', '[fd00::', '*.example.com/8']) {
      expect(() => parseRule(bad), bad).toThrow()
    }
  })
})

describe('name lookups for the guest', () => {
  const table: Record<string, string[]> = {
    'example.test': ['93.184.216.34', '2606:2800:220:1::1'],
    'internal.test': ['10.0.0.5'],
    'mixed.test': ['10.0.0.5', '93.184.216.35'],
    'lab.test': ['192.168.1.20'],
    'local.test': ['127.0.0.2']
  }
  const resolve = async (host: string) => table[host] ?? Promise.reject(new Error('ENOTFOUND'))
  const ask = (options: GatewayOptions, name: string, family: 4 | 6 = 4) => {
    const { guest, log } = link({ resolve, ...options })
    return { answer: resolveName(guest, name, { family, timeout: 2000 }), log }
  }

  it('answers with the addresses of the family asked for', async () => {
    expect(await ask({}, 'example.test').answer).toEqual(['93.184.216.34'])
    expect(await ask({}, 'example.test', 6).answer).toEqual(['2606:2800:220:1::1'])
  })

  it('answers an address literal with itself, and logs the lookup', async () => {
    const { answer, log } = ask({}, '93.184.216.34')
    expect(await answer).toEqual(['93.184.216.34'])
    expect(log.join('\n')).toContain('lookup 93.184.216.34')
  })

  it('does not tell a guest where a name inside this host\'s network points, unless a rule names that range', async () => {
    await expect(ask({}, 'internal.test').answer).rejects.toThrow(/does not reach/)
    await expect(ask({}, 'lab.test').answer).rejects.toThrow(/does not reach/)
    await expect(ask({ allow: [parseRule('lab.test')] }, 'lab.test').answer).rejects.toThrow(/does not reach/) // a name rule never opens an address
    expect(await ask({ allow: [parseRule('192.168.1.0/24')] }, 'lab.test').answer).toEqual(['192.168.1.20'])
  })

  it('leaves out only the addresses it would not connect to', async () => {
    expect(await ask({}, 'mixed.test').answer).toEqual(['93.184.216.35'])
  })

  it('applies allow and deny rules to the name or its addresses, whatever the ports', async () => {
    await expect(ask({ deny: [parseRule('example.test')] }, 'example.test').answer).rejects.toThrow(/denied/)
    await expect(ask({ deny: [parseRule('93.184.216.0/24')] }, 'example.test').answer).rejects.toThrow(/denied|does not reach/)
    await expect(ask({ allow: [parseRule('other.test')] }, 'example.test').answer).rejects.toThrow(/not allowed/)
    expect(await ask({ allow: [parseRule('example.test:443')] }, 'example.test').answer).toEqual(['93.184.216.34'])
    expect(await ask({ allow: [parseRule('93.184.216.34')] }, 'example.test').answer).toEqual(['93.184.216.34'])
  })

  it('says so when the name does not resolve', async () => {
    await expect(ask({}, 'nope.test').answer).rejects.toThrow(/could not resolve/)
  })

  it('is for the users the gateway serves, like a flow', async () => {
    const { guest } = link({ resolve }, 'somebody')
    await expect(resolveName(guest, 'example.test', { timeout: 2000 })).rejects.toThrow(/may not use this gateway/)
  })

  it('refuses a request that is not a name', async () => {
    const { guest } = link({ resolve })
    await expect(resolveName(guest, 'a b', { timeout: 2000 })).rejects.toThrow()
    await expect(guest.open(NetChannel, { params: { proto: 'dns', name: 'x', family: 5 }, timeout: 2000 }).then(channel => channel.done)).resolves.toBeDefined()
  })
})

describe('a UDP flow through the gateway', () => {
  const sockets: Array<{ close(): void }> = []
  afterEach(() => { for (const socket of sockets.splice(0)) { try { socket.close() } catch { /* closed */ } } })

  async function udpEcho(address = '127.0.0.1') {
    const dgram = await import('node:dgram')
    const server = dgram.createSocket('udp4')
    sockets.push(server)
    server.on('message', (message, remote) => server.send(Buffer.from(message.toString().toUpperCase()), remote.port, remote.address))
    await new Promise<void>(resolve => server.bind(0, address, resolve))
    return server.address().port
  }
  const reachUdp = (guest: Connection, host: string, port: number) => openFlow(guest, { proto: 'udp', host, port }, { timeout: 2000 })
  const next = (channel: import('@ecmaos/peer').Channel) => new Promise<Uint8Array | undefined>(resolve => { channel.onMessage = message => resolve(datagramOf(message)) })

  it('carries datagrams both ways, one per message, and logs the flow', async () => {
    const port = await udpEcho()
    const { guest, log } = link({ allow: [parseRule('127.0.0.1')] })
    const flow = await reachUdp(guest, '127.0.0.1', port)
    expect(flow.address).toBe('127.0.0.1')
    const reply = next(flow.channel)
    flow.channel.send(datagram(new TextEncoder().encode('ping')))
    expect(text((await reply)!)).toBe('PING')
    const second = next(flow.channel)
    flow.channel.send(datagram(new TextEncoder().encode('again')))
    expect(text((await second)!)).toBe('AGAIN')
    flow.channel.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(log.join('\n')).toContain(`udp 127.0.0.1:${port} (127.0.0.1) opened`)
    expect(log.join('\n')).toMatch(/udp 127\.0\.0\.1:\d+ closed \(9 bytes out, 9 in\)/)
  })

  it('applies the same rules as TCP: a blocked address is closed unless a rule names it', async () => {
    const { guest } = link()
    await expect(reachUdp(guest, '127.0.0.1', 9)).rejects.toThrow(/does not reach/)
    await expect(reachUdp(guest, '169.254.169.254', 53)).rejects.toThrow(/does not reach/)
  })

  it('ignores a message that is not a datagram, and counts the flow against the limit', async () => {
    const port = await udpEcho()
    const { guest } = link({ allow: [parseRule('127.0.0.1')], maxFlows: 1 })
    const flow = await reachUdp(guest, '127.0.0.1', port)
    flow.channel.send({ op: 'nonsense' })
    await expect(reachUdp(guest, '127.0.0.1', port)).rejects.toThrow(/too many flows/)
  })

  it('ends a flow that has been idle', async () => {
    const port = await udpEcho()
    const { guest } = link({ allow: [parseRule('127.0.0.1')], idleMs: 80 })
    const flow = await reachUdp(guest, '127.0.0.1', port)
    expect((await flow.channel.done)?.code).toBe('timeout')
  })
})

/** A port nothing is using, found by asking for one and giving it back */
async function freePort() {
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

/** Connects to a port on the host side and collects what comes back until it ends */
function dial(port: number, send?: string) {
  const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true })
  const chunks: string[] = []
  socket.on('data', chunk => chunks.push(chunk.toString()))
  socket.on('error', () => {})
  socket.on('end', () => socket.end())
  if (send !== undefined) socket.on('connect', () => socket.write(send))
  const ended = new Promise<string>(resolve => socket.on('close', () => resolve(chunks.join(''))))
  return { socket, ended, chunks }
}

describe('inbound listening', () => {
  /** The guest side of a listener: connections come as channels the host opens; this one answers each in upper case */
  function guestEchoes(guest: Connection, seen: string[] = []) {
    guest.accept(NetChannel, async (channel: Channel) => {
      seen.push(parseNetAccept(channel.params).peer)
      channel.manualCredit = true
      channel.onData = data => { void channel.write(new TextEncoder().encode(text(data).toUpperCase())); channel.grant(data.length) }
      channel.onMessage = message => { if (message && typeof message === 'object' && !(message instanceof Uint8Array) && !Array.isArray(message) && message['op'] === 'eof') { channel.send({ op: 'eof' }) } }
    })
    return seen
  }

  it('is refused unless the operator named ports', async () => {
    const { guest } = link()
    await expect(openListener(guest, { port: 8080 }, { timeout: 2000 })).rejects.toThrow(/does not open ports/)
  })

  it('refuses a port outside the range, and is refused for a user who may not use the gateway', async () => {
    const port = await freePort()
    const { guest } = link({ listen: { ports: [[port, port]] } })
    await expect(openListener(guest, { port: 80, as: port + 1 }, { timeout: 2000 })).rejects.toThrow(/not one this gateway opens/)
    const other = link({ listen: { ports: [[port, port]] } }, 'mallory')
    await expect(openListener(other.guest, { port: 80, as: port }, { timeout: 2000 })).rejects.toThrow(/may not use/)
  })

  it('forwards a connection to the guest and carries bytes both ways', async () => {
    const port = await freePort()
    const { guest, log } = link({ listen: { ports: [[port, port]] } })
    const seen = guestEchoes(guest)
    const listener = await openListener(guest, { port: 3000, as: port }, { timeout: 2000 })
    expect(listener.port).toBe(port)
    expect(listener.address).toBe('127.0.0.1')
    const client = dial(port, 'hello')
    await new Promise(resolve => setTimeout(resolve, 100))
    client.socket.end()
    expect(await client.ended).toBe('HELLO')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(log.some(line => line.includes(`listening on 127.0.0.1:${port} for guest port 3000`))).toBe(true)
  })

  it('drops the connection when the guest has nothing to take it', async () => {
    const port = await freePort()
    const { guest } = link({ listen: { ports: [[port, port]] } })
    await openListener(guest, { port: 3000, as: port }, { timeout: 2000 })
    const client = dial(port, 'hi')
    expect(await client.ended).toBe('')
  })

  it('drops clients outside the allowed list and serves those inside it', async () => {
    const port = await freePort()
    const blocked = link({ listen: { ports: [[port, port]], allow: [parseRule('10.0.0.0/8')] } })
    guestEchoes(blocked.guest)
    await openListener(blocked.guest, { port: 3000, as: port }, { timeout: 2000 })
    expect(await dial(port, 'hi').ended).toBe('')
    expect(blocked.log.some(line => line.includes('not in the allowed list'))).toBe(true)

    const other = await freePort()
    const open = link({ listen: { ports: [[other, other]], allow: [parseRule('127.0.0.0/8')] } })
    guestEchoes(open.guest)
    await openListener(open.guest, { port: 3000, as: other }, { timeout: 2000 })
    const client = dial(other, 'hi')
    await new Promise(resolve => setTimeout(resolve, 150))
    client.socket.end()
    expect(await client.ended).toBe('HI')
  })

  it('stops listening when the guest closes the listener, and the port is free again', async () => {
    const port = await freePort()
    const { guest } = link({ listen: { ports: [[port, port]] } })
    guestEchoes(guest)
    const listener = await openListener(guest, { port: 3000, as: port }, { timeout: 2000 })
    listener.channel.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    const again = await openListener(guest, { port: 3000, as: port }, { timeout: 2000 })
    expect(again.port).toBe(port)
  })

  it('refuses a port already in use, and enforces the per-login listener limit', async () => {
    const port = await freePort()
    const taken = net.createServer()
    servers.push(taken)
    await new Promise<void>(resolve => taken.listen(port, '127.0.0.1', resolve))
    const { guest } = link({ listen: { ports: [[port, port]] } })
    await expect(openListener(guest, { port: 1, as: port }, { timeout: 2000 })).rejects.toThrow(/EADDRINUSE/)

    const a = await freePort()
    const b = await freePort()
    const limited = link({ listen: { ports: [[Math.min(a, b), Math.max(a, b)]], maxListeners: 1 } })
    await openListener(limited.guest, { port: 1, as: a }, { timeout: 2000 })
    await expect(openListener(limited.guest, { port: 2, as: b }, { timeout: 2000 })).rejects.toThrow(/too many listeners/)
  })

  it('closes the port when the link goes away', async () => {
    const port = await freePort()
    const { guest, host } = link({ listen: { ports: [[port, port]] } })
    await openListener(guest, { port: 3000, as: port }, { timeout: 2000 })
    guest.close()
    host.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    const client = dial(port)
    const code = await new Promise<string>(resolve => client.socket.on('error', error => resolve((error as NodeJS.ErrnoException).code ?? '')))
    expect(code).toBe('ECONNREFUSED')
  })

  it('drops connections beyond the per-listener limit', async () => {
    const port = await freePort()
    const { guest, log } = link({ listen: { ports: [[port, port]], maxInbound: 1 } })
    const held: Channel[] = []
    guest.accept(NetChannel, channel => { held.push(channel) })
    await openListener(guest, { port: 3000, as: port }, { timeout: 2000 })
    const first = dial(port)
    await new Promise(resolve => setTimeout(resolve, 100))
    const second = dial(port)
    await second.ended
    expect(log.some(line => line.includes('connections open'))).toBe(true)
    first.socket.destroy()
  })
})

describe('inbound datagrams', () => {
  const sockets: dgram.Socket[] = []
  afterEach(() => { for (const socket of sockets.splice(0)) try { socket.close() } catch { /* closed */ } })

  /** The guest side: every datagram that arrives is answered in upper case to the peer it came from */
  function guestAnswers(listener: { channel: Channel }, seen: string[] = []) {
    listener.channel.onMessage = message => {
      const got = peerDatagramOf(message)
      if (!got) return
      seen.push(got.peer)
      listener.channel.send(peerDatagram(new TextEncoder().encode(text(got.data).toUpperCase()), got.peer))
    }
    return seen
  }

  /** A UDP client on loopback: sends `message` to `port` and resolves with the first reply (or '' after a moment) */
  function ask(port: number, message: string, wait = 400) {
    const socket = dgram.createSocket('udp4')
    sockets.push(socket)
    return new Promise<{ reply: string, from: number }>(resolve => {
      const timer = setTimeout(() => resolve({ reply: '', from: (socket.address() as net.AddressInfo).port }), wait)
      socket.on('message', data => { clearTimeout(timer); resolve({ reply: data.toString(), from: (socket.address() as net.AddressInfo).port }) })
      socket.bind(0, '127.0.0.1', () => socket.send(message, port, '127.0.0.1'))
    })
  }

  it('carries datagrams in and replies to each peer that sent one', async () => {
    const port = await freePort()
    const { guest, log } = link({ listen: { ports: [[port, port]] } })
    const listener = await openListener(guest, { port: 5353, as: port, udp: true }, { timeout: 2000 })
    expect(listener.port).toBe(port)
    const seen = guestAnswers(listener)
    const [one, two] = await Promise.all([ask(port, 'one'), ask(port, 'two')])
    expect(one.reply).toBe('ONE')
    expect(two.reply).toBe('TWO')
    expect(seen).toHaveLength(2)
    expect(new Set(seen).size).toBe(2)
    expect(seen[0]).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(log.some(line => line.includes(`listening on udp 127.0.0.1:${port} for guest port 5353`))).toBe(true)
  })

  it('will not send to a peer that has not sent anything', async () => {
    const port = await freePort()
    const { guest, log } = link({ listen: { ports: [[port, port]] } })
    const listener = await openListener(guest, { port: 5353, as: port, udp: true }, { timeout: 2000 })
    listener.channel.send(peerDatagram(new TextEncoder().encode('hi'), '127.0.0.1:9'))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(log.some(line => line.includes('reply to 127.0.0.1:9 refused'))).toBe(true)
  })

  it('drops clients outside the allowed list', async () => {
    const port = await freePort()
    const { guest, log } = link({ listen: { ports: [[port, port]], allow: [parseRule('10.0.0.0/8')] } })
    const listener = await openListener(guest, { port: 5353, as: port, udp: true }, { timeout: 2000 })
    guestAnswers(listener)
    expect((await ask(port, 'x')).reply).toBe('')
    expect(log.some(line => line.includes('not in the allowed list'))).toBe(true)
  })

  it('shares the listener limit with TCP, and frees the port when closed', async () => {
    const a = await freePort()
    const b = await freePort()
    const { guest } = link({ listen: { ports: [[Math.min(a, b), Math.max(a, b)]], maxListeners: 1 } })
    const first = await openListener(guest, { port: 1, as: a, udp: true }, { timeout: 2000 })
    await expect(openListener(guest, { port: 2, as: b }, { timeout: 2000 })).rejects.toThrow(/too many listeners/)
    first.channel.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await openListener(guest, { port: 1, as: a, udp: true }, { timeout: 2000 })).port).toBe(a)
  })

  it('refuses a UDP port already in use', async () => {
    const port = await freePort()
    const taken = dgram.createSocket('udp4')
    sockets.push(taken)
    await new Promise<void>(resolve => taken.bind(port, '127.0.0.1', () => resolve()))
    const { guest } = link({ listen: { ports: [[port, port]] } })
    await expect(openListener(guest, { port: 1, as: port, udp: true }, { timeout: 2000 })).rejects.toThrow(/EADDRINUSE/)
  })
})
