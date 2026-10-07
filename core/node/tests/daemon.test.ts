import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Connection } from '@ecmaos/peer'

import { Session } from './session.ts'
import { dial, generateKeyPair, login, openShell } from './peer-client.ts'

const sessions: Session[] = []
const connections: Connection[] = []
const folders: string[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close()
  await Promise.all(sessions.splice(0).map(session => session.stop()))
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** Starts a machine listening on a free port and reads what it printed */
async function host(extra: string[] = [], data?: string) {
  const env = data ? { ...process.env, ECMAOS_DATA: data } : undefined
  const session = new Session(['--quiet', '--listen=0', ...extra], { env })
  sessions.push(session)
  await session.ready()
  await session.waitFor('host key SHA256:')
  const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(session.output)![1])
  const fingerprint = /host key (SHA256:\S+)/.exec(session.output)![1]!
  const code = /pairing code for (\w+): (\d{3}-\d{3})/.exec(session.output)?.[2]
  return { session, port, fingerprint, code }
}

const connect = async (port: number, options?: Parameters<typeof dial>[1]) => {
  const connection = await dial(port, options)
  connections.push(connection)
  return connection
}

describe('ecmaosd', () => {
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
  }, 30_000)

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
    await session.waitFor('only listens on a loopback address')
  })

  it('keeps its host key and the enrolled key across a restart', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'ecmaosd-data-'))
    folders.push(data)
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
  }, 60_000)

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

describe('connect, from one machine to another', () => {
  /** A second machine whose shell is at /tmp, so its prompt differs from the host's, which is at /root */
  async function client() {
    const session = new Session(['--quiet'])
    sessions.push(session)
    await session.ready()
    session.send('cd /tmp\r')
    await session.waitFor('root:/tmp# ')
    return session
  }

  /** Runs a command on the second machine (whose prompt is not the one `Session.run` looks for) and returns what it printed */
  async function local(session: Session, command: string) {
    const mark = session.output.length
    session.send(`${command}\r`)
    await session.waitFor('root:/tmp# ', mark + command.length)
    return session.output.slice(mark).split('\n').slice(1).join('\n').replace(/root:\/tmp# $/, '').trim()
  }

  const Remote = 'root:/root# '
  const Local = 'root:/tmp# '

  async function connectTo(session: Session, port: number, flags: string, answer = 'root') {
    const mark = session.output.length
    session.send(`connect ${flags} root@127.0.0.1:${port}\r`)
    await session.waitFor('unlocks your key', mark)
    session.send(`${answer}\r`)
    return mark
  }

  it('pairs a key, opens a shell on the other machine, and returns to its own on exit', async () => {
    const { port, code, fingerprint } = await host()
    const me = await client()

    const mark = await connectTo(me, port, `-y -p ${code}`)
    await me.waitFor(Remote, mark)
    expect(me.output.slice(mark)).toContain(`Added 127.0.0.1:${port} (${fingerprint})`)
    me.send('echo remote-$USER-$HOME\r')
    await me.waitFor('remote-root-/root', mark)
    me.send('exit\r')
    await me.waitFor('Connection closed.', mark)
    await me.waitFor(Local, mark)

    expect(await local(me, 'cat /root/.ssh/known_hosts')).toMatch(new RegExp(`^127\\.0\\.0\\.1:${port} ecdsa-p384 `))
    expect(await local(me, 'ls -l /root/.ssh/id_ecdsa')).toMatch(/^-rw-------/)
  })

  it('logs in with the enrolled key alone the second time, and keeps the terminal usable afterwards', async () => {
    const { port, code } = await host()
    const me = await client()
    let mark = await connectTo(me, port, `-y -p ${code}`)
    await me.waitFor(Remote, mark)
    me.send('exit\r')
    await me.waitFor(Local, mark)

    mark = await connectTo(me, port, '')
    await me.waitFor(Remote, mark)
    me.send('exit\r')
    await me.waitFor('Connection closed.', mark)
    await me.waitFor(Local, mark)
    // echo and line editing are back on the local terminal
    expect(await local(me, 'echo local-again')).toBe('local-again')
  }, 60_000)

  it('refuses a wrong password before anything is sent, and a wrong key', async () => {
    const { port, code, session: remote } = await host()
    const me = await client()
    let mark = await connectTo(me, port, `-y -p ${code}`, 'not-the-password')
    await me.waitFor('connect: Invalid password', mark)
    await me.waitFor(Local, mark)
    // nothing was enrolled
    expect(await remote.run('cat /root/.ssh/authorized_keys 2>&1')).not.toContain('ecdsa-p384')

    // a key that was never enrolled is refused with the generic message
    mark = await connectTo(me, port, '-y')
    await me.waitFor('connect: authentication failed', mark)
    await me.waitFor(Local, mark)
  }, 60_000)

  it('refuses a host whose key is not the pinned one, and a mismatched --fingerprint', async () => {
    const { port, code } = await host()
    const me = await client()
    const mark = me.output.length
    me.send(`connect -F SHA256:wrong root@127.0.0.1:${port}\r`)
    await me.waitFor('not SHA256:wrong', mark)
    await me.waitFor(Local, mark)

    // pin a different key for this address, then connect: the warning, and no password prompt
    await local(me, 'mkdir -p /root/.ssh')
    await local(me, `echo "127.0.0.1:${port} ecdsa-p384 ${btoa(JSON.stringify({ kty: 'EC', crv: 'P-384', x: 'A'.repeat(64), y: 'B'.repeat(64) }))}" > /root/.ssh/known_hosts`)
    const second = me.output.length
    me.send(`connect -p ${code} root@127.0.0.1:${port}\r`)
    await me.waitFor('HAS CHANGED', second)
    await me.waitFor(Local, second)
    expect(me.output.slice(second)).not.toContain('unlocks your key')
  }, 60_000)

  it('says plainly when nothing is listening', async () => {
    const me = await client()
    const mark = me.output.length
    me.send('connect -y root@127.0.0.1:1\r')
    await me.waitFor('connect: could not connect', mark)
    await me.waitFor(Local, mark)
  })
})
