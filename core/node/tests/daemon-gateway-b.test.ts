import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'

import { Session } from './session.ts'
import { afterEachClose, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('the network gateway: a program connects', () => {
  it('a program that connect()s to a far address goes through the gateway once gateway up has made one', async () => {
    // 127.0.0.2 is not "this machine" to the guest (only 127.0.0.1 is), but it is a loopback address the host can reach
    const target = net.createServer(socket => socket.on('data', chunk => socket.write(chunk.toString().toUpperCase())))
    await new Promise<void>(resolve => target.listen(0, '127.0.0.2', resolve))
    afterEachClose.push(() => target.close())
    const targetPort = (target.address() as net.AddressInfo).port
    const { port, code, session } = await host(['--gateway', `--gateway-allow=127.0.0.2:${targetPort}`])

    // the client program, with the port it should connect to patched into its sockaddr (network byte order after the family)
    const wasm = Buffer.from(readFileSync(path.resolve(import.meta.dirname, 'fixtures/gateway-client.wasm')))
    const at = wasm.indexOf(Buffer.from([0x02, 0x00, 0x23, 0x28, 0x7f, 0x00, 0x00, 0x02]))
    expect(at).toBeGreaterThan(0)
    wasm.writeUInt16BE(targetPort, at + 2)

    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await me.run(`echo ${wasm.toString('base64')} | base64 -d > /tmp/gw.wasm; chmod 755 /tmp/gw.wasm`)

    // no gateway yet: no route, ENETUNREACH (40)
    expect(await me.run('/tmp/gw.wasm; echo code=$?')).toContain('code=40')

    const mark = me.output.length
    me.send(`gateway up root@127.0.0.1:${port} --pair ${code} -y\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('is up as root', mark)
    await me.waitFor('root:/root# ', me.output.indexOf('is up as root', mark))
    expect(await me.run('gateway')).toContain('flows open')

    expect(await me.run('/tmp/gw.wasm; echo code=$?')).toMatch(/HELLO GW\s*code=0/)
    await session.waitFor(`root -> 127.0.0.2:${targetPort} (127.0.0.2) opened`)

    expect(await me.run('gateway down')).toContain('closed')
    expect(await me.run('/tmp/gw.wasm; echo code=$?')).toContain('code=40')
  })

  it('a program connecting somewhere the gateway does not allow gets EACCES', async () => {
    const { port, code } = await host(['--gateway', '--gateway-allow=example.com'])
    const wasm = Buffer.from(readFileSync(path.resolve(import.meta.dirname, 'fixtures/gateway-client.wasm')))
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await me.run(`echo ${wasm.toString('base64')} | base64 -d > /tmp/gw.wasm; chmod 755 /tmp/gw.wasm`)
    const mark = me.output.length
    me.send(`gateway up root@127.0.0.1:${port} --pair ${code} -y\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('is up as root', mark)
    await me.waitFor('root:/root# ', me.output.indexOf('is up as root', mark))
    expect(await me.run('/tmp/gw.wasm; echo code=$?')).toContain('code=2')
  })
})
