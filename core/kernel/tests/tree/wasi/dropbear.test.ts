import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/dropbear` and the links to it: a server and an ssh client in one system, talking over loopback. The server
 * forks a process for each connection, which runs the command (or a login shell on a pty), so this is sockets and fork
 * together.
 */
describe('dropbear: ssh, scp and dropbearkey', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
    // the program is installed in the background; wait until it starts
    for (let tries = 0; tries < 100 && await kernel.shell.execute('dropbearkey -t ed25519 -f /tmp/probe > /dev/null 2>&1') !== 0; tries++) await new Promise(resolve => setTimeout(resolve, 500))
  }, 120000)

  const sh = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/d.out 2> /tmp/d.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/d.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/d.err', 'utf8')
    }
  }

  it('makes a key and prints its public half and fingerprint', async () => {
    const made = await sh('dropbearkey -t ed25519 -f /tmp/k1')
    expect(made.code, JSON.stringify(made)).toBe(0)
    const shown = await sh('dropbearkey -y -f /tmp/k1')
    expect(shown.code, JSON.stringify(shown)).toBe(0)
    expect(shown.out).toMatch(/^Public key portion is:\nssh-ed25519 AAAA\S+ \S*\nFingerprint: SHA256:\S+\n/)
  }, 60000)

  const serve = async () => {
    expect((await sh('dropbearkey -t ed25519 -f /tmp/hostkey')).code).toBe(0)
    expect((await sh('dropbearkey -t ed25519 -f /tmp/id')).code).toBe(0)
    const pub = (await sh('dropbearkey -y -f /tmp/id')).out.split('\n')[1]
    await kernel.filesystem.fs.mkdir('/root/.ssh', { recursive: true })
    await kernel.filesystem.fs.writeFile('/root/.ssh/authorized_keys', pub + '\n')
    await kernel.shell.execute('chmod 700 /root /root/.ssh; chmod 600 /root/.ssh/authorized_keys')
    // the server forks for each connection, and the session's command is a fork of that
    void kernel.shell.execute('dropbear -F -E -s -r /tmp/hostkey -p 127.0.0.1:2222 > /tmp/server.out 2>&1')
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  const ssh = (command: string) => sh(`ssh -y -i /tmp/id -p 2222 root@127.0.0.1 ${command}`)

  it('runs commands on a server over loopback: output, status and stdin', async () => {
    await serve()
    const server = async () => await kernel.filesystem.fs.readFile('/tmp/server.out', 'utf8')
    const ran = await ssh('"echo hello from \\$(whoami)"')
    expect(ran.code, JSON.stringify({ ...ran, server: await server() })).toBe(0)
    expect(ran.out).toBe('hello from root\n')
    expect((await ssh('"exit 3"')).code).toBe(3)
    expect((await sh('echo piped | ssh -y -i /tmp/id -p 2222 root@127.0.0.1 "cat; echo end"')).out).toBe('piped\nend\n')
  }, 120000)

  it('copies a file with scp, both ways', async () => {
    // scp runs ssh without -y, so the host's key must be a known one
    const hostPub = (await sh('dropbearkey -y -f /tmp/hostkey')).out.split('\n')[1].split(' ').slice(0, 2).join(' ')
    await kernel.filesystem.fs.writeFile('/root/.ssh/known_hosts', `127.0.0.1 ${hostPub}\n`)
    const data = 'ecmaOS '.repeat(5000)
    await kernel.filesystem.fs.writeFile('/tmp/up.txt', data)
    const up = await sh('scp -i /tmp/id -P 2222 /tmp/up.txt root@127.0.0.1:/tmp/there.txt')
    expect(up.code, JSON.stringify(up)).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/there.txt', 'utf8')).toBe(data)
    const down = await sh('scp -i /tmp/id -P 2222 root@127.0.0.1:/tmp/there.txt /tmp/back.txt')
    expect(down.code, JSON.stringify(down)).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/back.txt', 'utf8')).toBe(data)
  }, 120000)
})
