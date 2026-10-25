import { describe, expect, it } from 'vitest'

import { dial, generateKeyPair, login, openShell } from './peer-client.ts'

import { Session } from './session.ts'
import { connect, connections, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('ecmaosd: pairing and who may log in', () => {
  it('pairs a key with the printed code, then logs in with the key alone and gets a shell', async () => {
    const { port, fingerprint, code } = await host()
    const key = await generateKeyPair()

    const first = await connect(port)
    const seen = await login(first, 'root', key, { code: code! })
    expect(seen.fingerprint).toBe(fingerprint)
    first.close()

    const second = await connect(port)
    await login(second, 'root', key)
    const shell = await openShell(second)
    await shell.waitFor('root:/root# ')
    expect(await shell.run('echo hello from a peer')).toContain('hello from a peer')
    expect(await shell.run('id -u')).toContain('0')
  })

  it('a pairing code works once', async () => {
    const { port, code } = await host()
    const one = await generateKeyPair()
    const two = await generateKeyPair()
    await login(await connect(port), 'root', one, { code: code! })
    await expect(login(await connect(port), 'root', two, { code: code! })).rejects.toMatchObject({ code: 'auth' })
    // and the second key was not enrolled
    await expect(login(await connect(port), 'root', two)).rejects.toMatchObject({ code: 'auth' })
  })

  it('three wrong codes burn the real one', async () => {
    const { port, code } = await host()
    const key = await generateKeyPair()
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(login(await connect(port), 'root', key, { code: '000-000' })).rejects.toMatchObject({ code: 'auth' })
    }
    await expect(login(await connect(port), 'root', key, { code: code! })).rejects.toMatchObject({ code: 'auth' })
  })

  it('refuses an unknown key and an unknown user the same way, and slowly', async () => {
    const { port } = await host(['--no-pair'])
    const key = await generateKeyPair()
    const started = Date.now()
    const messages: string[] = []
    for (const user of ['root', 'nobody-here']) {
      const error = await login(await connect(port), user, key).catch(error => error)
      expect(error.code).toBe('auth')
      messages.push(error.message)
    }
    expect(new Set(messages).size).toBe(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
  })

  it('does not issue a pairing code with --no-pair, and enrolling is then impossible', async () => {
    const { port, code } = await host(['--no-pair'])
    expect(code).toBeUndefined()
    await expect(login(await connect(port), 'root', await generateKeyPair(), { code: '123-456' })).rejects.toMatchObject({ code: 'auth' })
  })

  it('checks the Origin and the Host of the request', async () => {
    const { port } = await host(['--allow-origin=https://app.example'])
    await expect(dial(port, { origin: 'https://evil.example' })).rejects.toThrow(/403/)
    await expect(dial(port, { headers: { Host: 'rebind.example' } })).rejects.toThrow(/403/)
    connections.push(await dial(port, { origin: 'https://app.example' }))
    // a client that sends no Origin (not a browser) is let through to the login
    connections.push(await dial(port))
  })

  it('only listens on a loopback address', async () => {
    const session = new Session(['--quiet', '--listen=0.0.0.0:0'])
    sessions.push(session)
    await session.ready()
    await session.waitFor('only listens on a loopback address without TLS')
  })
})
