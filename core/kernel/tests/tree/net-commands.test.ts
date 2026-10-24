import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `ip`, `w` and `ss` (without a socket listening, for that see toybox-proc.test.ts): they read the machine's own state. */
describe('ip, w and ss', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  }, 120000)

  const sh = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/n.out 2> /tmp/n.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/n.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/n.err', 'utf8') }
  }

  it('ip addr shows the loopback, which is the machine\'s one interface', async () => {
    const ran = await sh('ip addr')
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536')
    expect(ran.out).toContain('inet 127.0.0.1/8 scope host lo')
    expect(ran.out).toContain('inet6 ::1/128 scope host')
    expect((await sh('ip -4 addr')).out).not.toContain('inet6')
    expect((await sh('ip -br addr')).out).toBe('lo               UNKNOWN        127.0.0.1/8 ::1/128\n')
  })

  it('ip link shows lo, ip route shows nothing, and a change is refused', async () => {
    expect((await sh('ip link')).out).toContain('link/loopback 00:00:00:00:00:00')
    expect((await sh('ip route')).out).toBe('')
    expect((await sh('ip addr add 10.0.0.2/24 dev lo')).code).toBe(2)
    expect((await sh('ip addr show dev eth0')).err).toBe('Device "eth0" does not exist.\n')
    expect((await sh('ip frobnicate')).err).toBe('Object "frobnicate" is unknown, try "ip help".\n')
  })

  it('w prints the uptime line, the header and a row for each login', async () => {
    await kernel.filesystem.fs.mkdir('/run', { recursive: true })
    await kernel.filesystem.fs.writeFile('/run/utmp', `alice\ttty3\t${Date.now()}\n`)
    const ran = await sh('w')
    expect(ran.code, ran.err).toBe(0)
    const [uptime, header, row] = ran.out.split('\n')
    expect(uptime).toMatch(/^ \d\d:\d\d:\d\d up .*, +1 user, +load average: \d+\.\d\d, \d+\.\d\d, \d+\.\d\d$/)
    expect(header).toMatch(/^USER +TTY +FROM +LOGIN@ +IDLE +JCPU +PCPU WHAT$/)
    expect(row).toMatch(/^alice +tty3 /)
    expect((await sh('w -h')).out.split('\n')[0]).toMatch(/^alice /)
    expect((await sh('w bob')).out.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('ss prints its header and nothing else with no sockets', async () => {
    const ran = await sh('ss -ltn')
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toMatch(/^State +Recv-Q +Send-Q +Local Address:Port +Peer Address:Port/)
    expect((await sh('ss -x -l')).out).toMatch(/^State /)
    expect((await sh('ss -z')).code).toBe(1)
  })
})

/** `host`, `nslookup`, `dig` and `ping` with no gateway up: /etc/hosts answers, and anything else says no server can be reached. */
describe('host, nslookup, dig and ping', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  }, 120000)

  const sh = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/d.out 2> /tmp/d.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/d.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/d.err', 'utf8') }
  }

  it('host answers a name in /etc/hosts, in both families', async () => {
    const ran = await sh('host localhost')
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain('localhost has address 127.0.0.1')
    expect(ran.out).toContain('localhost has IPv6 address ::1')
    expect((await sh('host -4 localhost')).out).toBe('localhost has address 127.0.0.1\n')
    expect((await sh('host -t AAAA localhost')).out).toBe('localhost has IPv6 address ::1\n')
  })

  it('dig prints an answer section, or only the addresses with +short', async () => {
    const ran = await sh('dig localhost')
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain(';localhost.\t\t\tIN\tA')
    expect(ran.out).toContain('localhost.\t\t0\tIN\tA\t127.0.0.1')
    expect((await sh('dig +short localhost AAAA')).out).toBe('::1\n')
    expect((await sh('dig localhost MX')).code).toBe(1)
  })

  it('nslookup prints the name and its addresses', async () => {
    const ran = await sh('nslookup localhost')
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toContain('Non-authoritative answer:\nName:\tlocalhost\nAddress: 127.0.0.1\n')
  })

  it('a name that /etc/hosts lacks cannot be looked up without a gateway', async () => {
    const ran = await sh('host example.com')
    expect(ran.code).toBe(1)
    expect(ran.err).toContain('no servers could be reached')
    expect((await sh('dig +short example.com')).code).toBe(9)
    expect((await sh('host 1.2.3.4')).err).toContain('reverse lookups are not available')
  })

  it('ping says that localhost is this machine, and a remote host cannot be reached without a gateway', async () => {
    const local = await sh('ping localhost')
    expect(local.code, local.err).toBe(0)
    expect(local.out).toContain('that is this machine')
    const remote = await sh('ping -c 1 example.com')
    expect(remote.code).toBe(2)
    expect(remote.err).toContain('ping: example.com:')
  })
})
