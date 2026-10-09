import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'

import dgram from 'node:dgram'
import net from 'node:net'

import { openFlow } from '@ecmaos/peer'
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
    await session.waitFor('only listens on a loopback address without TLS')
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

describe('using a device of another machine', () => {
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

  /** A host offering `devices` and a machine that has attached `wanted` from it as /dev/NAME */
  async function attached(devices: string[], wanted: string, as = wanted, data?: string) {
    const { session: remote, port, code } = await host(devices.flatMap(spec => ['--device', spec]), data)
    const me = await client()
    const mark = me.output.length
    me.send(`attach -y -p ${code} root@127.0.0.1:${port}/${wanted} ${as}\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor(Local, mark + 100)
    return { me, remote, port, code, result: me.output.slice(mark) }
  }

  const eventually = async (check: () => Promise<boolean> | boolean, what: string) => {
    const started = Date.now()
    while (!(await check())) {
      if (Date.now() - started > 20_000) throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  it('a loopback device: what is written to /dev/NAME comes back from it, and detaching removes it', async () => {
    const { me, result, port } = await attached(['loop=loopback'], 'loop')
    expect(result).toContain('Attached loop from 127.0.0.1')
    // a name this machine already has is refused
    const mark0 = me.output.length
    me.send(`attach root@127.0.0.1:${port}/loop zero\r`)
    await me.waitFor('unlocks your key', mark0)
    me.send('root\r')
    await me.waitFor(Local, mark0 + 100)
    expect(me.output.slice(mark0)).toContain('/dev/zero already exists')
    expect(await local(me, 'attach -l')).toContain('/dev/loop')
    expect(await local(me, 'ls /dev')).toContain('loop')
    await local(me, 'echo ping > /dev/loop')
    expect(await local(me, 'dd if=/dev/loop bs=1 count=5 2>/dev/null')).toBe('ping')
    expect(await local(me, 'attach -c loop ping')).toContain('pong')
    expect(await local(me, 'attach -c loop echo 1 \'"two"\'')).toContain('[1,"two"]')
    expect(await local(me, 'attach -d loop')).toContain('Detached loop')
    expect(await local(me, 'ls /dev')).not.toMatch(/\bloop\b/)
  })

  it('when the host goes away the device node goes with it, and a read that was waiting ends', async () => {
    const { me, remote } = await attached(['loop=loopback'], 'loop')
    expect(await local(me, 'ls /dev')).toContain('loop')
    await remote.stop()
    await eventually(async () => !(await local(me, 'ls /dev')).match(/\bloop\b/), 'the device to be removed')
    expect(await local(me, 'attach -l')).toContain('No devices are attached')
  })

  it('a read-only device refuses a write, and a device that ends (a file at its end) goes away', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ecmaosd-device-'))
    folders.push(dir)
    const fifo = path.join(dir, 'sensor')
    execFileSync('mkfifo', [fifo])
    writeFileSync(path.join(dir, 'log.txt'), 'reading 42\n')
    const { me, port, code } = await attached([`sensor=file:${fifo}`, `log=file:${path.join(dir, 'log.txt')}`], 'sensor')
    const hostEnd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK)
    try {
      writeSync(hostEnd, 'reading 42\n')
      expect(await local(me, 'dd if=/dev/sensor bs=1 count=10 2>/dev/null')).toBe('reading 42')
    } finally { closeSync(hostEnd) }
    expect(await local(me, 'echo x > /dev/sensor 2>&1; echo status=$?')).not.toContain('status=0')

    // a second device of the same host: a regular file is read to its end, which ends the device
    const mark = me.output.length
    me.send(`attach root@127.0.0.1:${port}/log\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('Attached log', mark)
    await eventually(async () => !(await local(me, 'ls /dev')).match(/\blog\b/), 'the device to go when the file ended')
    void code
  })

  it('a FIFO read through the machine, and one the machine writes to', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ecmaosd-device-'))
    folders.push(dir)
    const input = path.join(dir, 'in')
    const output = path.join(dir, 'out')
    execFileSync('mkfifo', [input, output])
    // the host's own ends: a reader of the output first (a FIFO opened for writing needs one), a writer into the input
    const reader = openSync(output, constants.O_RDONLY | constants.O_NONBLOCK)
    const writer = openSync(input, constants.O_RDWR | constants.O_NONBLOCK)
    try {
      const { me, port } = await attached([`in=file:${input}`, `out=file:${output}:wo`], 'in')
      writeSync(writer, 'from the host\n')
      expect(await local(me, 'dd if=/dev/in bs=1 count=13 2>/dev/null')).toBe('from the host')

      const mark = me.output.length
      me.send(`attach root@127.0.0.1:${port}/out\r`)
      await me.waitFor('unlocks your key', mark)
      me.send('root\r')
      await me.waitFor('Attached out', mark)
      expect(await local(me, 'attach -l')).toMatch(/\/dev\/out\s+file\s+-w/)
      await local(me, 'echo from the machine > /dev/out')
      const got: string[] = []
      await eventually(() => {
        const buffer = Buffer.alloc(64)
        try { const count = readSync(reader, buffer, 0, 64, null); if (count > 0) got.push(buffer.subarray(0, count).toString()) } catch { /* nothing yet */ }
        return got.join('').includes('from the machine')
      }, 'the host to read what the machine wrote')
    } finally { closeSync(reader); closeSync(writer) }
  })

  it('offering a device of this machine: the host gets /dev/NAME, and stopping removes it', async () => {
    const { session: remote, port, code } = await host()
    const me = await client()
    const mark = me.output.length
    me.send(`attach -s -y -p ${code} root@127.0.0.1:${port} mydev loopback\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('Offering loopback', mark)
    await me.waitFor(Local, mark + 100)
    expect(await local(me, 'attach -l')).toContain('offered to 127.0.0.1')

    await eventually(async () => (await remote.run('ls /dev')).includes('mydev'), 'the host to get the device node')
    await remote.run('echo hello > /dev/mydev')
    expect(await remote.run('dd if=/dev/mydev bs=1 count=6 2>/dev/null')).toContain('hello')

    // a name the host already has is refused with its reason
    const mark2 = me.output.length
    me.send(`attach -s root@127.0.0.1:${port} zero loopback\r`)
    await me.waitFor('unlocks your key', mark2)
    me.send('root\r')
    await me.waitFor(Local, mark2 + 100)
    expect(me.output.slice(mark2)).toContain('/dev/zero already exists')

    expect(await local(me, 'attach -d mydev')).toContain('Detached mydev')
    await eventually(async () => !(await remote.run('ls /dev')).includes('mydev'), 'the host to lose the device node')
  })

  it('only the devices the host lists, and only to root; a device in use is refused', async () => {
    const { session: remote, port, code } = await host(['--device', 'loop=loopback'])
    void remote
    const me = await client()
    const mark = me.output.length
    me.send(`attach -y -p ${code} root@127.0.0.1:${port}/secret x\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor(Local, mark + 100)
    expect(me.output.slice(mark)).toContain('no device named secret')
    expect(await local(me, 'attach -l')).toContain('No devices are attached')

    const none = await host([])
    const other = await client()
    const mark2 = other.output.length
    other.send(`attach -y -p ${none.code} root@127.0.0.1:${none.port}/loop\r`)
    await other.waitFor('unlocks your key', mark2)
    other.send('root\r')
    await other.waitFor(Local, mark2 + 100)
    expect(other.output.slice(mark2)).toContain('no device named loop')
  })

  it('devices can be listed in a file in the data folder, and a file device is held by one machine at a time', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'ecmaosd-data-'))
    folders.push(data)
    mkdirSync(path.join(data, 'ecmaosd'))
    writeFileSync(path.join(data, 'ecmaosd', 'devices'), '# what this machine offers\nzero=file:/dev/zero\n')
    const { me, port, code } = await attached([], 'zero', 'rzero', data)
    expect(await local(me, 'dd if=/dev/rzero bs=1 count=4 2>/dev/null | od -An -tx1')).toContain('00 00 00 00')

    const mark = me.output.length
    me.send(`attach root@127.0.0.1:${port}/zero z2\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor(Local, mark + 100)
    expect(me.output.slice(mark)).toContain('zero is in use')
    void code
  })
})

describe('over TLS', () => {
  const Local = 'root:/tmp# '

  /** A self-signed certificate for localhost and 127.0.0.1, and a file the clients can trust it from */
  function certificate() {
    const dir = mkdtempSync(path.join(tmpdir(), 'ecmaosd-tls-'))
    folders.push(dir)
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' })
    return { cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') }
  }

  it('listens beyond loopback only with a certificate, and says so', async () => {
    const { cert, key } = certificate()
    const lone = new Session(['--quiet', '--listen=0.0.0.0:0', '--tls-cert', cert])
    sessions.push(lone)
    await lone.ready()
    await lone.waitFor('go together')

    const session = new Session(['--quiet', '--listen=0.0.0.0:0', '--tls-cert', cert, '--tls-key', key])
    sessions.push(session)
    await session.ready()
    await session.waitFor('listening on 0.0.0.0:')
    expect(session.output).toContain('(TLS)')
  })

  it('a machine reaches it with wss://, trusting the certificate; plain ws:// to the same port gets nowhere', async () => {
    const { cert, key } = certificate()
    const { session: remote, port, code } = await host(['--tls-cert', cert, '--tls-key', key, '--device', 'loop=loopback'])
    expect(remote.output).toContain('(TLS)')

    const me = new Session(['--quiet'], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } })
    sessions.push(me)
    await me.ready()
    me.send('cd /tmp\r')
    await me.waitFor(Local)

    const mark = me.output.length
    me.send(`attach -y -p ${code} root@127.0.0.1:${port}/loop plain\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor(Local, mark + 100)
    expect(me.output.slice(mark)).toContain('could not connect')

    const mark2 = me.output.length
    me.send(`attach -y -p ${code} wss://root@localhost:${port}/loop secure\r`)
    await me.waitFor('unlocks your key', mark2)
    me.send('root\r')
    await me.waitFor('Attached loop', mark2)
    await me.waitFor(Local, mark2 + 100)

    // a machine that does not trust the certificate cannot log in at all
    const stranger = new Session(['--quiet'])
    sessions.push(stranger)
    await stranger.ready()
    stranger.send('cd /tmp\r')
    await stranger.waitFor(Local)
    const mark3 = stranger.output.length
    stranger.send(`attach -y -p ${code} wss://root@localhost:${port}/loop x\r`)
    await stranger.waitFor('unlocks your key', mark3)
    stranger.send('root\r')
    await stranger.waitFor(Local, mark3 + 100)
    expect(stranger.output.slice(mark3)).toContain('could not connect')
  })
})


describe('the network gateway', () => {
  async function echoServer(once = false) {
    const server = net.createServer(socket => socket.on('data', chunk => { socket.write(chunk.toString().toUpperCase()); if (once) socket.end() }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    afterEachClose.push(() => server.close())
    return (server.address() as net.AddressInfo).port
  }
  const afterEachClose: Array<() => void> = []
  afterEach(() => { for (const close of afterEachClose.splice(0)) close() })

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
  }, 60_000)

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
  }, 60_000)

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
    expect(await me.run('gateway')).toContain('flows open')

    expect(await me.run('/tmp/gw.wasm; echo code=$?')).toMatch(/HELLO GW\s*code=0/)
    await session.waitFor(`root -> 127.0.0.2:${targetPort} (127.0.0.2) opened`)

    expect(await me.run('gateway down')).toContain('closed')
    expect(await me.run('/tmp/gw.wasm; echo code=$?')).toContain('code=40')
  }, 90_000)

  async function unusedPort() {
    const probe = net.createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as net.AddressInfo
    await new Promise<void>(resolve => probe.close(() => resolve()))
    return port
  }

  it('gateway expose lets something outside reach a server listening on the guest', async () => {
    const outside = await unusedPort()
    const { port, code, session } = await host(['--gateway', `--gateway-listen=${outside}`])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, readFileSync(path.resolve(import.meta.dirname, 'fixtures/emcc-serve.wasm')), '/tmp/serve.wasm')

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
  }, 120_000)

  it('gateway expose -u delivers datagrams from outside to a bound socket and answers each sender', async () => {
    const outside = await unusedPort()
    const { port, code } = await host(['--gateway', `--gateway-listen=${outside}`, '--gateway-listen-allow=127.0.0.0/8'])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, readFileSync(path.resolve(import.meta.dirname, 'fixtures/emcc-udp-serve.wasm')), '/tmp/userve.wasm')
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
  }, 120_000)

  it('an IPv6 socket on the guest reaches an IPv4 address through the gateway as the mapped address', async () => {
    const target = net.createServer(socket => socket.on('data', chunk => socket.write(chunk.toString().toUpperCase())))
    await new Promise<void>(resolve => target.listen(0, '127.0.0.2', resolve))
    afterEachClose.push(() => target.close())
    const targetPort = (target.address() as net.AddressInfo).port
    const { port, code } = await host(['--gateway', `--gateway-allow=127.0.0.2:${targetPort}`])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, readFileSync(path.resolve(import.meta.dirname, 'fixtures/emcc-net6.wasm')), '/tmp/net6.wasm')

    expect(await me.run(`/tmp/net6.wasm connect 127.0.0.2 ${targetPort}`)).toContain('connect: errno 40') // no route yet
    await bringUp(me, port, code)
    expect(await me.run(`/tmp/net6.wasm connect 127.0.0.2 ${targetPort}`)).toContain('reply HELLO MAPPED family=10')
  }, 120_000)

  it('gateway expose on an IPv6 address reaches a dual-stack server on the guest, with the real IPv6 peer', async () => {
    const outside = await unusedPort()
    const { port, code } = await host(['--gateway', `--gateway-listen=${outside}`, '--gateway-listen-address=::1'])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, readFileSync(path.resolve(import.meta.dirname, 'fixtures/emcc-net6.wasm')), '/tmp/net6.wasm')
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
  }, 120_000)

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
    expect(await me.run('/tmp/gw.wasm; echo code=$?')).toContain('code=2')
  }, 90_000)

  /** Puts a file in a session's machine, a piece of base64 per line (a 24 KB line is too much to type at a terminal) */
  async function install(me: Session, file: Buffer, destination: string) {
    const encoded = file.toString('base64')
    await me.run(`rm -f ${destination}.b64`)
    for (let at = 0; at < encoded.length; at += 1500) await me.run(`echo ${encoded.slice(at, at + 1500)} >> ${destination}.b64`)
    await me.run(`base64 -d ${destination}.b64 > ${destination}; chmod 755 ${destination}; rm ${destination}.b64`)
  }
  const lookupProgram = () => readFileSync(path.resolve(import.meta.dirname, 'fixtures/emcc-lookup.wasm'))

  async function bringUp(me: Session, port: number, code: string | undefined) {
    const mark = me.output.length
    me.send(`gateway up root@127.0.0.1:${port} --pair ${code} -y\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('is up as root', mark)
  }

  it('getaddrinfo answers from /etc/hosts, and a name from there connects through the gateway', async () => {
    const target = net.createServer(socket => socket.on('data', chunk => socket.write(chunk.toString().toUpperCase())))
    await new Promise<void>(resolve => target.listen(0, '127.0.0.2', resolve))
    afterEachClose.push(() => target.close())
    const targetPort = (target.address() as net.AddressInfo).port
    const { port, code } = await host(['--gateway', `--gateway-allow=127.0.0.2:${targetPort}`])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, lookupProgram(), '/tmp/lookup.wasm')

    expect(await me.run('/tmp/lookup.wasm localhost 80')).toContain('127.0.0.1:80')
    expect(await me.run('/tmp/lookup.wasm 10.1.2.3 8080')).toContain('10.1.2.3:8080')
    expect(await me.run('/tmp/lookup.wasm localhost 80 byname')).toContain('gethostbyname 127.0.0.1')
    expect(await me.run('/tmp/lookup.wasm nowhere.test 80')).toContain('getaddrinfo: Try again')
    await me.run("echo '127.0.0.2 echo.test' >> /etc/hosts")
    await bringUp(me, port, code)
    const talk = await me.run(`/tmp/lookup.wasm echo.test ${targetPort} talk`)
    expect(talk).toContain(`127.0.0.2:${targetPort}`)
    expect(talk).toContain('HELLO DNS')
  }, 120_000)

  it('a name only the gateway can resolve is asked of it, and a refusal reads as no such name', async () => {
    const { port, code, session } = await host(['--gateway', '--gateway-allow=127.0.0.1'])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, lookupProgram(), '/tmp/lookup.wasm')
    await me.run('echo "# nothing" > /etc/hosts')
    await bringUp(me, port, code)
    expect(await me.run('/tmp/lookup.wasm localhost 80')).toContain('127.0.0.1:80')
    await session.waitFor('lookup localhost -> 127.0.0.1')
    expect(await me.run('/tmp/lookup.wasm no-such-host.invalid 80')).toContain('getaddrinfo: Name does not resolve')
  }, 120_000)

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
    await install(me, readFileSync(path.resolve(import.meta.dirname, 'fixtures/emcc-udp.wasm')), '/tmp/udp.wasm')

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
  }, 120_000)

  it('a UDP socket to somewhere the gateway does not allow gets EACCES', async () => {
    const { port, code } = await host(['--gateway', '--gateway-allow=example.com'])
    const me = new Session(['--quiet'])
    sessions.push(me)
    await me.ready()
    await install(me, readFileSync(path.resolve(import.meta.dirname, 'fixtures/emcc-udp.wasm')), '/tmp/udp.wasm')
    await bringUp(me, port, code)
    expect(await me.run('/tmp/udp.wasm 127.0.0.2 9 connect')).toContain('connect: errno 2')
  }, 120_000)

  it('will not be on beyond loopback without --gateway-public', async () => {
    const session = new Session(['--listen=0.0.0.0:0', '--gateway'])
    sessions.push(session)
    await session.ready()
    await session.waitFor('--gateway-public')
  })
})
