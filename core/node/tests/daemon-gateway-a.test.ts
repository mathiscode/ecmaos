import { describe, expect, it } from 'vitest'

import { openFlow } from '@ecmaos/peer'

import { generateKeyPair, login } from './peer-client.ts'

import { Session } from './session.ts'
import { connect, echoServer, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('the network gateway: access', () => {
  it('is not there unless asked for', async () => {
    const { port, code } = await host()
    const key = await generateKeyPair()
    const connection = await connect(port)
    await login(connection, 'root', key, { code: code! })
    await expect(openFlow(connection, { proto: 'tcp', host: 'example.com', port: 80 }, { timeout: 2000 })).rejects.toThrow(/no handler for net|unsupported/)
  })

  it('carries a flow to a TCP server when asked for, and keeps this host closed unless a rule opens it', async () => {
    const target = await echoServer()
    const { port, code, session } = await host(['--gateway', '--gateway-allow=127.0.0.1:' + target])
    const key = await generateKeyPair()
    const connection = await connect(port)
    await login(connection, 'root', key, { code: code! })

    const flow = await openFlow(connection, { proto: 'tcp', host: '127.0.0.1', port: target }, { timeout: 5000 })
    await flow.channel.write(new TextEncoder().encode('through the gateway'))
    expect(new TextDecoder().decode((await flow.channel.read())!)).toBe('THROUGH THE GATEWAY')

    // a rule for one port does not open the others, nor this host's other services
    await expect(openFlow(connection, { proto: 'tcp', host: '127.0.0.1', port: port }, { timeout: 2000 })).rejects.toThrow(/not allowed|does not reach/)
    await session.waitFor(`root -> 127.0.0.1:${target} (127.0.0.1) opened`)
  })

  it('refuses a user who is not on the list', async () => {
    const { port, code } = await host(['--gateway', '--gateway-user=somebody-else'])
    const key = await generateKeyPair()
    const connection = await connect(port)
    await login(connection, 'root', key, { code: code! })
    await expect(openFlow(connection, { proto: 'tcp', host: 'example.com', port: 80 }, { timeout: 2000 })).rejects.toThrow(/may not use this gateway/)
  })

  it('nc -g from another machine reaches a TCP server through the host', async () => {
    const target = await echoServer(true)
    const { port, code } = await host(['--gateway', '--gateway-allow=127.0.0.1:' + target])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    const mark = me.output.length
    me.send(`nc -g root@127.0.0.1:${port} --pair ${code} -y 127.0.0.1 ${target}\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('connected', mark).catch(() => {})
    me.send('ping through nc\r')
    await me.waitFor('PING THROUGH NC', mark)
    await me.waitFor('root:/root# ', me.output.indexOf('PING THROUGH NC', mark))
  })

  it('nc -g says why when the gateway refuses', async () => {
    const { port, code } = await host(['--gateway', '--gateway-allow=example.com'])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    const mark = me.output.length
    me.send(`nc -g root@127.0.0.1:${port} --pair ${code} -y 127.0.0.1 22\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('nc: ', mark + 100)
    await me.waitFor('root:/root# ', mark + 200)
    expect(me.output.slice(mark)).toMatch(/does not reach|not allowed/)
  })
})
