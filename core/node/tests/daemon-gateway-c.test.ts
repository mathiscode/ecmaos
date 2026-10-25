import { describe, expect, it } from 'vitest'
import dgram from 'node:dgram'
import net from 'node:net'

import { Session } from './session.ts'
import { afterEachClose, bringUp, host, install, sessions, unusedPort, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('the network gateway: exposing a port', () => {
  it('gateway expose lets something outside reach a server listening on the guest', async () => {
    const outside = await unusedPort()
    const { port, code, session } = await host(['--gateway', `--gateway-listen=${outside}`])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, 'emcc-serve.wasm', '/tmp/serve.wasm')

    // no gateway: no route
    expect(await me.run(`gateway expose 3000 ${outside}`)).toContain('no gateway is up')
    await bringUp(me, port, code)
    // a gateway that opens the port, but nothing listening yet
    expect(await me.run(`gateway expose 3000 ${outside + 1}`)).toContain('not one this gateway opens')
    expect(await me.run(`gateway expose 3000 ${outside}`)).toContain(`reachable at 127.0.0.1:${outside}`)
    expect(await me.run('gateway')).toContain(`Exposed: 127.0.0.1:${outside} -> port 3000 here`)
    expect(await me.run('gateway')).toContain('nothing is listening on it here')

    // nothing listening on 3000 yet: the connection is dropped
    const refused = await new Promise<string>(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port: outside }, () => socket.write('early'))
      const chunks: string[] = []
      socket.on('data', chunk => chunks.push(chunk.toString()))
      socket.on('error', () => {})
      socket.on('close', () => resolve(chunks.join('')))
    })
    expect(refused).toBe('')

    await me.run('/tmp/serve.wasm 3000 2 > /tmp/serve.out 2>&1 &')
    for (let i = 0; i < 50 && !(await me.run('cat /tmp/serve.out')).includes('listening'); i++) await new Promise(resolve => setTimeout(resolve, 100))

    expect(await me.run('gateway')).not.toContain('nothing is listening')
    const talk = (text: string, localAddress?: string) => new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: outside, localAddress }, () => { socket.write(text); socket.end() })
      const chunks: string[] = []
      socket.on('data', chunk => chunks.push(chunk.toString()))
      socket.on('error', reject)
      socket.on('close', () => resolve(chunks.join('')))
    })
    expect(await talk('hello inbound')).toBe('HELLO INBOUND|BYE')
    expect(await talk('second one', '127.0.0.2')).toBe('SECOND ONE|BYE')
    expect(await me.run('cat /tmp/serve.out')).toMatch(/peer 127\.0\.0\.1\s+peer 127\.0\.0\.2/)
    await session.waitFor(`listening on 127.0.0.1:${outside} for guest port 3000`)
    expect(await me.run('gateway')).toContain('2 so far')

    expect(await me.run(`gateway unexpose ${outside}`)).toContain('Stopped forwarding')
    const gone = await new Promise<string>(resolve => { const socket = net.connect({ host: '127.0.0.1', port: outside }); socket.on('error', error => resolve((error as NodeJS.ErrnoException).code ?? '')); socket.on('connect', () => { socket.destroy(); resolve('connected') }) })
    expect(gone).toBe('ECONNREFUSED')
  })

  it('gateway expose -u delivers datagrams from outside to a bound socket and answers each sender', async () => {
    const outside = await unusedPort()
    const { port, code } = await host(['--gateway', `--gateway-listen=${outside}`, '--gateway-listen-allow=127.0.0.0/8'])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, 'emcc-udp-serve.wasm', '/tmp/userve.wasm')
    await bringUp(me, port, code)

    expect(await me.run(`gateway expose -u 5300 ${outside}`)).toContain(`UDP port 5300 is reachable at 127.0.0.1:${outside}`)
    expect(await me.run('gateway')).toContain(`Exposed: udp 127.0.0.1:${outside} -> port 5300 here`)
    expect(await me.run('gateway')).toContain('nothing is listening on it here')

    await me.run('/tmp/userve.wasm 5300 2 > /tmp/userve.out 2>&1 &')
    for (let i = 0; i < 50 && !(await me.run('cat /tmp/userve.out')).includes('listening'); i++) await new Promise(resolve => setTimeout(resolve, 100))

    expect(await me.run('gateway')).not.toContain('nothing is listening')
    // two different clients, one socket on the guest: each gets its own answer, and the program saw the real sender
    const ask = (text: string) => new Promise<string>((resolve, reject) => {
      const socket = dgram.createSocket('udp4')
      const timer = setTimeout(() => { socket.close(); reject(new Error('no reply')) }, 15_000)
      socket.on('message', data => { clearTimeout(timer); socket.close(); resolve(data.toString()) })
      socket.send(text, outside, '127.0.0.1')
    })
    expect(await ask('first client')).toBe('FIRST CLIENT|127.0.0.1')
    expect(await ask('second client')).toBe('SECOND CLIENT|127.0.0.1')
    expect(await me.run('gateway')).toContain('2 peers so far')
  })

  it('an IPv6 socket on the guest reaches an IPv4 address through the gateway as the mapped address', async () => {
    const target = net.createServer(socket => socket.on('data', chunk => socket.write(chunk.toString().toUpperCase())))
    await new Promise<void>(resolve => target.listen(0, '127.0.0.2', resolve))
    afterEachClose.push(() => target.close())
    const targetPort = (target.address() as net.AddressInfo).port
    const { port, code } = await host(['--gateway', `--gateway-allow=127.0.0.2:${targetPort}`])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, 'emcc-net6.wasm', '/tmp/net6.wasm')

    expect(await me.run(`/tmp/net6.wasm connect 127.0.0.2 ${targetPort}`)).toContain('connect: errno 40') // no route yet
    await bringUp(me, port, code)
    expect(await me.run(`/tmp/net6.wasm connect 127.0.0.2 ${targetPort}`)).toContain('reply HELLO MAPPED family=10')
  })

  it('gateway expose on an IPv6 address reaches a dual-stack server on the guest, with the real IPv6 peer', async () => {
    const outside = await unusedPort()
    const { port, code } = await host(['--gateway', `--gateway-listen=${outside}`, '--gateway-listen-address=::1'])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, 'emcc-net6.wasm', '/tmp/net6.wasm')
    await bringUp(me, port, code)

    expect(await me.run(`gateway expose 3000 ${outside}`)).toContain(`reachable at [::1]:${outside}`)
    expect(await me.run('gateway')).toContain(`Exposed: [::1]:${outside} -> port 3000 here`)
    await me.run('/tmp/net6.wasm serve tcp 3000 > /tmp/net6.out 2>&1 &')
    for (let i = 0; i < 50 && !(await me.run('cat /tmp/net6.out')).includes('listening'); i++) await new Promise(resolve => setTimeout(resolve, 100))
    const talk = (text: string) => new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '::1', port: outside }, () => { socket.write(text); socket.end() })
      const chunks: string[] = []
      socket.on('data', chunk => chunks.push(chunk.toString()))
      socket.on('error', reject)
      socket.on('close', () => resolve(chunks.join('')))
    })
    expect(await talk('hello six')).toBe('HELLO SIX|BYE')
    expect(await me.run('cat /tmp/net6.out')).toMatch(/peer ::1\s/)

    // the same for datagrams, on the same outside port once the first is closed
    expect(await me.run(`gateway unexpose ${outside}`)).toContain('Stopped forwarding')
    expect(await me.run(`gateway expose -u 5300 ${outside}`)).toContain(`UDP port 5300 is reachable at [::1]:${outside}`)
    await me.run('/tmp/net6.wasm serve udp 5300 > /tmp/net6u.out 2>&1 &')
    for (let i = 0; i < 50 && !(await me.run('cat /tmp/net6u.out')).includes('listening'); i++) await new Promise(resolve => setTimeout(resolve, 100))
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = dgram.createSocket('udp6')
      const timer = setTimeout(() => { socket.close(); reject(new Error('no reply')) }, 15_000)
      socket.on('message', data => { clearTimeout(timer); socket.close(); resolve(data.toString()) })
      socket.send('datagram six', outside, '::1')
    })
    expect(reply).toBe('DATAGRAM SIX|::1')
  })
})
