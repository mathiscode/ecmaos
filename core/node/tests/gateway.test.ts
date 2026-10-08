import { afterEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import type { Server } from 'node:net'

import { Connection, memoryPair, NetChannel, openFlow, PeerError } from '@ecmaos/peer'

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
