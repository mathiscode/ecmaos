import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { generateKeyPair, login, openShell } from './peer-client.ts'

import { connect, dataFolder, host, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('ecmaosd: what it keeps, and its sessions', () => {
  it('keeps its host key and the enrolled key across a restart', async () => {
    const data = dataFolder()
    const first = await host([], data)
    const key = await generateKeyPair()
    await login(await connect(first.port), 'root', key, { code: first.code! })
    await first.session.stop()

    const second = await host(['--no-pair'], data)
    expect(second.fingerprint).toBe(first.fingerprint)
    const seen = await login(await connect(second.port), 'root', key)
    expect(seen.fingerprint).toBe(first.fingerprint)

    const hostKeyFile = path.join(data, 'ecmaosd', 'host_key.json')
    expect(statSync(hostKeyFile).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(hostKeyFile, 'utf8')).publicKey.kty).toBe('EC')
  })

  it('the enrolled key is in the user\'s authorized_keys, owned by them and private', async () => {
    const { session, port, code } = await host()
    const key = await generateKeyPair()
    await login(await connect(port), 'root', key, { code: code! })
    expect(await session.run('ls -l /root/.ssh/authorized_keys')).toMatch(/^-rw-------/)
    expect(await session.run('cat /root/.ssh/authorized_keys')).toMatch(/^ecdsa-p384 \S+ paired-/)
  })

  it('gives each login a terminal of its own and frees it when it ends', async () => {
    const { port, code } = await host()
    const key = await generateKeyPair()
    await login(await connect(port), 'root', key, { code: code! })

    const a = await connect(port); await login(a, 'root', key)
    const b = await connect(port); await login(b, 'root', key)
    const one = await openShell(a)
    const two = await openShell(b)
    await one.waitFor('root:/root# ')
    await two.waitFor('root:/root# ')
    await one.run('cd /tmp')
    expect(await one.run('pwd')).toContain('/tmp')
    expect(await two.run('pwd')).toContain('/root')

    // more sessions than terminals, one after another: each ending must give its terminal back
    for (let round = 0; round < 9; round++) {
      const c = await connect(port); await login(c, 'root', key)
      const shell = await openShell(c)
      await shell.waitFor('root:/root# ')
      c.close()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(await one.run('echo still-here')).toContain('still-here')
  })

  it('typing exit ends the session and closes the channel', async () => {
    const { port, code } = await host()
    const key = await generateKeyPair()
    const connection = await connect(port)
    await login(connection, 'root', key, { code: code! })
    const shell = await openShell(connection)
    await shell.waitFor('root:/root# ')
    await shell.send('exit\r')
    expect(await shell.channel.done).toBeUndefined()
    // the login is still good: another shell can be opened on the same connection
    const again = await openShell(connection)
    await again.waitFor('root:/root# ')
  })
})
