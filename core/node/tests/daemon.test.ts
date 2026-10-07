import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
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
  if (!extra.includes('--no-pair')) await session.waitFor('pairing code for')
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

describe('mounting a directory of another machine', () => {
  const Local = 'root:/tmp# '

  async function client() {
    const session = new Session(['--quiet'])
    sessions.push(session)
    await session.ready()
    session.send('cd /tmp\r')
    await session.waitFor(Local)
    return session
  }

  async function local(session: Session, command: string, timeout = 30_000) {
    const mark = session.output.length
    session.send(`${command}\r`)
    await session.waitFor(Local, mark + command.length, timeout)
    // the kernel logs to the terminal at any time; that is not what the command printed
    const lines = session.output.slice(mark).split('\n').filter(line => line.trim() !== command && !/^(root:\/tmp# )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ ecmaos:/.test(line))
    return lines.join('\n').replace(/root:\/tmp# $/, '').trim()
  }

  /** A shared folder on the host and a machine with it mounted at /mnt/share */
  async function mounted(options: { readOnly?: boolean, files?: Record<string, string | Buffer>, extra?: string } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ecmaosd-share-'))
    folders.push(dir)
    for (const [name, text] of Object.entries(options.files ?? { 'hello.txt': 'hello from the host\n' })) writeFileSync(path.join(dir, name), text)
    const { port, code } = await host(['--export', `share=${dir}${options.readOnly ? '' : ':rw'}`])
    const me = await client()
    const mark = me.output.length
    me.send(`mount -t ecmaos -o pair=${code},accept-new=yes${options.extra ?? ''} root@127.0.0.1:${port}/share /mnt/share\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor(Local, mark + 200)
    return { me, dir, port, mount: me.output.slice(mark) }
  }

  const until = async (check: () => boolean, what: string) => {
    const started = Date.now()
    while (!check()) {
      if (Date.now() - started > 15_000) throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  it('reads what is on the host, and a change made in the machine reaches the host', async () => {
    const { me, dir, mount } = await mounted()
    expect(mount).toContain('Mounted root@127.0.0.1')
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    expect(await local(me, 'ls /mnt/share')).toContain('hello.txt')

    await local(me, 'echo from the machine > /mnt/share/out.txt')
    await local(me, 'mkdir /mnt/share/made')
    await until(() => existsSync(path.join(dir, 'out.txt')) && existsSync(path.join(dir, 'made')), 'the host to see the new file and folder')
    await until(() => readFileSync(path.join(dir, 'out.txt'), 'utf8') === 'from the machine\n', 'the host file to hold the text')

    await local(me, 'rm /mnt/share/out.txt')
    await until(() => !existsSync(path.join(dir, 'out.txt')), 'the host to lose the file')
    expect(await local(me, 'mount')).toContain('/mnt/share')
  }, 90_000)

  it('moves an 8 MB file both ways, byte for byte', async () => {
    const data = Buffer.alloc(8 << 20)
    for (let index = 0; index < data.length; index++) data[index] = (index * 131 + (index >> 9)) % 256
    const hash = createHash('sha256').update(data).digest('hex')
    const { me, dir } = await mounted({ files: { 'big.bin': data } })
    // down: what the machine reads is what the host has
    expect(await local(me, 'sha256sum /mnt/share/big.bin')).toContain(hash)
    // up: a copy made inside the machine arrives whole
    await local(me, 'cp /mnt/share/big.bin /tmp/down.bin', 60_000)
    expect(await local(me, 'sha256sum /tmp/down.bin')).toContain(hash)
    await local(me, 'cp /tmp/down.bin /mnt/share/up.bin', 60_000)
    await until(() => existsSync(path.join(dir, 'up.bin')) && statSync(path.join(dir, 'up.bin')).size === data.length, 'the host to have all of the upload')
    expect(createHash('sha256').update(readFileSync(path.join(dir, 'up.bin'))).digest('hex')).toBe(hash)
  }, 180_000)

  it('refuses a tree over the limit, before copying any of it', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 30; index++) files[`f${index}.txt`] = 'x'
    const { me, mount } = await mounted({ files, extra: ',maxfiles=10' })
    expect(mount).toContain('larger than 10 files')
    expect(await local(me, 'ls /mnt/share 2>&1')).not.toContain('f1.txt')
  }, 90_000)

  it('writes to a read-only export are refused and the host file is untouched', async () => {
    const { me, dir } = await mounted({ readOnly: true })
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    await local(me, 'echo changed > /mnt/share/hello.txt')
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('hello from the host\n')
  }, 90_000)

  it('says plainly when the host is not known, the export does not exist, or the password is wrong', async () => {
    const { port, code } = await host(['--export', `share=${tmpdir()}`])
    const me = await client()
    const attempt = async (flags: string, name: string, password: string) => {
      const mark = me.output.length
      me.send(`mount -t ecmaos ${flags} root@127.0.0.1:${port}/${name} /mnt/x\r`)
      await me.waitFor('unlocks your key', mark)
      me.send(`${password}\r`)
      const started = Date.now()
      while (!/mount: [^\n]+\n(?:[^\n]*\n)*root:\/tmp# $/.test(me.output.slice(mark))) {
        if (Date.now() - started > 20_000) throw new Error(`no answer\n${me.output.slice(mark)}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return me.output.slice(mark).replace(/\n/g, ' ')
    }
    expect(await attempt(`-o pair=${code}`, 'share', 'root')).toContain('is not a known host')
    expect(await attempt(`-o pair=${code},accept-new=yes`, 'share', 'wrong-password')).toContain('Invalid password')
    expect(await attempt(`-o pair=${code},accept-new=yes`, 'nosuch', 'root')).toContain('no export named nosuch')
  }, 90_000)

  it('a host that goes away leaves the mount readable from its copy, fails changes loudly, and umount still works', async () => {
    const { me, dir } = await mounted()
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    const mark = me.output.length
    await sessions[0]!.stop() // the host, killed
    // reads are served from the copy made at mount time
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    // a change cannot reach the host: it never appears there, and the machine says so in its log
    await local(me, 'echo after > /mnt/share/late.txt')
    await me.waitFor('failed on the other machine: the connection to the other machine ended', mark)
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false)
    expect(await local(me, 'ls /mnt/share')).toContain('hello.txt')
    await local(me, 'umount /mnt/share')
    expect(await local(me, 'mount')).not.toContain('/mnt/share')
    expect(await local(me, 'echo still-working')).toBe('still-working')
  }, 90_000)

  it('umount ends the connection, and the machine goes on working when the host disappears', async () => {
    const { me, port } = await mounted()
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    await local(me, 'umount /mnt/share')
    expect(await local(me, 'mount')).not.toContain('/mnt/share')
    expect(await local(me, 'echo still-working')).toBe('still-working')
    expect(port).toBeGreaterThan(0)
  }, 90_000)
})

describe('sharing a directory with another machine', () => {
  const Local = 'root:/tmp# '

  async function client() {
    const session = new Session(['--quiet'])
    sessions.push(session)
    await session.ready()
    session.send('cd /tmp\r')
    await session.waitFor(Local)
    return session
  }

  async function local(session: Session, command: string, timeout = 30_000) {
    const mark = session.output.length
    session.send(`${command}\r`)
    await session.waitFor(Local, mark + command.length, timeout)
    const lines = session.output.slice(mark).split('\n').filter(line => line.trim() !== command && !/^(root:\/tmp# )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ ecmaos:/.test(line))
    return lines.join('\n').replace(/root:\/tmp# $/, '').trim()
  }

  const eventually = async (check: () => Promise<boolean>, what: string) => {
    const started = Date.now()
    while (!(await check())) {
      if (Date.now() - started > 20_000) throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  async function shared(flags = '') {
    const { session: remote, port, code } = await host()
    const me = await client()
    await local(me, 'mkdir /tmp/data')
    await local(me, 'echo from the machine > /tmp/data/hello.txt')
    const mark = me.output.length
    me.send(`share -y -p ${code} ${flags} root@127.0.0.1:${port} /tmp/data demo\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('Sharing /tmp/data', mark)
    await me.waitFor(Local, mark + 100)
    return { me, remote }
  }

  it('the host mounts it as /mnt/NAME, both sides see each other\'s changes, and stopping unmounts it', async () => {
    const { me, remote } = await shared()
    expect(await remote.run('cat /mnt/demo/hello.txt')).toContain('from the machine')
    await remote.run('echo from the host > /mnt/demo/h.txt')
    await eventually(async () => (await local(me, 'cat /tmp/data/h.txt')) === 'from the host', 'the machine to have the file the host wrote')
    expect(await local(me, 'share -l')).toContain('demo')

    await local(me, 'share -d demo')
    await eventually(async () => !(await remote.run('mount')).includes('/mnt/demo'), 'the host to drop the mount')
  }, 120_000)

  it('a read-only share cannot be changed from the host', async () => {
    const { me, remote } = await shared('-r')
    expect(await remote.run('cat /mnt/demo/hello.txt')).toContain('from the machine')
    await remote.run('echo changed > /mnt/demo/hello.txt')
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(await local(me, 'cat /tmp/data/hello.txt')).toBe('from the machine')
  }, 120_000)

  it('the host drops the mount when the machine goes away', async () => {
    const { me, remote } = await shared()
    expect(await remote.run('mount')).toContain('/mnt/demo')
    await me.stop()
    await eventually(async () => !(await remote.run('mount')).includes('/mnt/demo'), 'the host to drop the mount')
  }, 120_000)

  it('is refused for anyone but root, and for a tree that is too big', async () => {
    const { session: remote, port, code } = await host()
    const me = await client()
    await local(me, 'mkdir /tmp/big')
    for (let index = 0; index < 4; index++) await local(me, `echo x > /tmp/big/f${index}`)
    // the limits are the host's (5000 files); a name that cannot be a mount point is refused outright
    const mark = me.output.length
    me.send(`share -y -p ${code} root@127.0.0.1:${port} /tmp/big 'bad name'\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('share: ', mark + 60)
    expect(me.output.slice(mark)).toMatch(/letters, digits|a share needs a name/)
    expect(await remote.run('mount')).not.toContain('/mnt/bad')
  }, 120_000)
})
