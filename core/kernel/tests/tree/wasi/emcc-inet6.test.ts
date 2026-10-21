import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * IPv6 on this machine, through a real emcc build (`fixtures/emcc-inet6.c`) and the same program on WALI's musl
 * (`fixtures/wali.build.sh`): name resolution, sockaddr_in6, v6-only and dual-stack listeners, IPv6 UDP, and the
 * errors for the wrong family or a destination beyond the machine. Nothing here needs a gateway. Where the two C
 * libraries differ as libraries, both are taken: musl orders addresses by RFC 6724 (`::1` first, as on Linux) and
 * writes a mapped address as `::ffff:127.0.0.1`; emscripten's resolver gives IPv4 first and its `inet_ntop` the bare
 * IPv4 address.
 */
describe.each(['emcc', 'wali'])('the %s build using IPv6 sockets', abi => {
  let kernel: Kernel
  let out: string

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/${abi}-inet6.wasm`)
    await kernel.filesystem.fs.writeFile(`/tmp/${abi}-inet6`, new Uint8Array(bytes), { mode: 0o755 })
    expect(await kernel.shell.execute(`/tmp/${abi}-inet6 > /tmp/${abi}-inet6.out 2>&1`)).toBe(0)
    out = await kernel.filesystem.fs.readFile(`/tmp/${abi}-inet6.out`, 'utf8')
  }, 60_000)

  const lines = (prefix: string) => out.split('\n').filter(line => line.startsWith(`${prefix} `) || line === prefix)

  it('resolves names to sockaddr_in6, both families when no family is asked for', () => {
    expect(lines('gai-literal')).toEqual(['gai-literal fam=10 len=28 ::1 port=80'])
    expect(lines('gai-localhost').sort()).toEqual(['gai-localhost fam=10 len=28 ::1 port=80', 'gai-localhost fam=2 len=16 127.0.0.1 port=80'])
    expect(lines('gai-passive6')).toEqual(['gai-passive6 fam=10 len=28 :: port=80'])
    expect(lines('gai-passive-any').map(line => line.split(' ')[3]).sort()).toEqual(['0.0.0.0', '::'])
    expect(lines('gai-wrong-family')).toEqual(['gai-wrong-family failed'])
  })

  it('answers getnameinfo from /etc/hosts and the service names, and reports a buffer that is too small', () => {
    expect(out).toContain('reverse rc=0 localhost http')
    expect(out).toContain('short buffer rc=-12')
  })

  it('connects over ::1 to a v6-only listener and names both ends as IPv6', () => {
    expect(out).toContain('connect6 0')
    expect(lines('accepted')).toEqual(['accepted fam=10 len=28 ::1 port=0'])
    expect(out).toContain('server read ping6')
    expect(lines('sockname')).toEqual(['sockname fam=10 len=28 ::1 port=5501'])
    expect(out).toContain('v6only=1')
  })

  it('lets a dual-stack listener take both families, showing an IPv4 client as the mapped address', () => {
    expect(out).toContain('connect4-to-dual 0')
    expect(lines('dual-from-v4')).toEqual([expect.stringMatching(/^dual-from-v4 fam=10 len=28 (::ffff:)?127\.0\.0\.1 port=0$/)])
    expect(out).toContain('connect6-to-dual 0')
    expect(lines('dual-from-v6')).toEqual(['dual-from-v6 fam=10 len=28 ::1 port=0'])
  })

  it('keeps a dual-stack port to itself but lets an IPv4 listener share a port with an IPv6-only one', () => {
    expect(out).toContain('v4-bind-over-dual -1 EADDRINUSE')
    expect(out).toContain('v4-beside-v6only 1 0')
  })

  it('exchanges IPv6 datagrams, with the sender named as sockaddr_in6 both ways', () => {
    expect(out).toContain('udp-bind 0')
    expect(out).toContain('udp-send 6')
    const from = lines('udp-from')[0]!
    expect(from).toMatch(/^udp-from fam=10 len=28 ::1 port=\d+$/)
    expect(from).not.toContain('port=0')
    expect(out).toContain('udp-got 6 dgram6')
    expect(lines('udp-reply-from')).toEqual(['udp-reply-from fam=10 len=28 ::1 port=5504'])
    expect(out).toContain('udp-reply 4 back')
  })

  it('refuses an address of the wrong family for the socket, and a destination with no route', () => {
    expect(out).toContain('v4-socket-v6-address -1 EAFNOSUPPORT')
    expect(out).toContain('v6-socket-v4-address -1 EINVAL')
    expect(out).toContain('far-connect -1 ENETUNREACH')
    expect(out).toContain('far-send -1 ENETUNREACH')
  })
})
