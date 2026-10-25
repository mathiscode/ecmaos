import { describe, expect, it } from 'vitest'
import net from 'node:net'

import { Session } from './session.ts'
import { afterEachClose, bringUp, host, install, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('the network gateway: names and UDP', () => {
  it('getaddrinfo answers from /etc/hosts, and a name from there connects through the gateway', async () => {
    const target = net.createServer(socket => socket.on('data', chunk => socket.write(chunk.toString().toUpperCase())))
    await new Promise<void>(resolve => target.listen(0, '127.0.0.2', resolve))
    afterEachClose.push(() => target.close())
    const targetPort = (target.address() as net.AddressInfo).port
    const { port, code } = await host(['--gateway', `--gateway-allow=127.0.0.2:${targetPort}`])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, 'emcc-lookup.wasm', '/tmp/lookup.wasm')

    expect(await me.run('/tmp/lookup.wasm localhost 80')).toContain('127.0.0.1:80')
    expect(await me.run('/tmp/lookup.wasm 10.1.2.3 8080')).toContain('10.1.2.3:8080')
    expect(await me.run('/tmp/lookup.wasm localhost 80 byname')).toContain('gethostbyname 127.0.0.1')
    expect(await me.run('/tmp/lookup.wasm nowhere.test 80')).toContain('getaddrinfo: Try again')
    await me.run("echo '127.0.0.2 echo.test' >> /etc/hosts")
    await bringUp(me, port, code)
    const talk = await me.run(`/tmp/lookup.wasm echo.test ${targetPort} talk`)
    expect(talk).toContain(`127.0.0.2:${targetPort}`)
    expect(talk).toContain('HELLO DNS')
  })

  it('a name only the gateway can resolve is asked of it, and a refusal reads as no such name', async () => {
    const { port, code, session } = await host(['--gateway', '--gateway-allow=127.0.0.1'])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, 'emcc-lookup.wasm', '/tmp/lookup.wasm')
    await me.run('echo "# nothing" > /etc/hosts')
    await bringUp(me, port, code)
    expect(await me.run('/tmp/lookup.wasm localhost 80')).toContain('127.0.0.1:80')
    await session.waitFor('lookup localhost -> 127.0.0.1')
    expect(await me.run('/tmp/lookup.wasm no-such-host.invalid 80')).toContain('getaddrinfo: Name does not resolve')
  })

  it('a program\'s UDP socket reaches a UDP server through the gateway, with datagram boundaries kept', async () => {
    const dgram = await import('node:dgram')
    const server = dgram.createSocket('udp4')
    server.on('message', (message, remote) => server.send(Buffer.from(message.toString().toUpperCase()), remote.port, remote.address))
    await new Promise<void>(resolve => server.bind(0, '127.0.0.2', resolve))
    afterEachClose.push(() => server.close())
    const targetPort = server.address().port
    const { port, code, session } = await host(['--gateway', `--gateway-allow=127.0.0.2:${targetPort}`])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, 'emcc-udp.wasm', '/tmp/udp.wasm')

    // no gateway: no route
    expect(await me.run(`/tmp/udp.wasm 127.0.0.2 ${targetPort} connect`)).toContain('connect: errno 40')
    await bringUp(me, port, code)
    const connected = await me.run(`/tmp/udp.wasm 127.0.0.2 ${targetPort} connect`)
    expect(connected).toContain('PING UDP')
    expect(connected).toContain('big 3000 B C')
    const sent = await me.run(`/tmp/udp.wasm 127.0.0.2 ${targetPort} sendto`)
    expect(sent).toContain(`from port ${targetPort}`)
    expect(sent).toContain('PING UDP')
    expect(sent).toContain('big 3000 B C')
    await session.waitFor(`root -> udp 127.0.0.2:${targetPort} (127.0.0.2) opened`)
  })

  it('a UDP socket to somewhere the gateway does not allow gets EACCES', async () => {
    const { port, code } = await host(['--gateway', '--gateway-allow=example.com'])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, 'emcc-udp.wasm', '/tmp/udp.wasm')
    await bringUp(me, port, code)
    expect(await me.run('/tmp/udp.wasm 127.0.0.2 9 connect')).toContain('connect: errno 2')
  })

  it('will not be on beyond loopback without --gateway-public', async () => {
    const session = new Session(['--listen=0.0.0.0:0', '--gateway'])
    sessions.push(session)
    await session.ready()
    await session.waitFor('--gateway-public')
  })
})
