import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `ifconfig`, `route`, `arp`, `blkid`, `look` and `dc`, commands of `@ecmaos/coreutils` */
describe('network listings, blkid, look and dc', () => {
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
    await kernel.filesystem.fs.writeFile('/tmp/words', 'apple\nApricot\nbanana\nberry\ncherry\n')
  }, 120000)

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/mc.out 2> /tmp/mc.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/mc.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/mc.err', 'utf8') }
  }
  const dc = async (program: string) => (await run(`dc -e '${program}'`)).out

  it('ifconfig shows the loopback and nothing else', async () => {
    const result = await run('ifconfig')
    expect(result.code).toBe(0)
    expect(result.out).toContain('lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536')
    expect(result.out).toContain('inet 127.0.0.1  netmask 255.0.0.0')
    expect((await run('ifconfig -s')).out).toContain('Iface      MTU')
    const missing = await run('ifconfig eth0')
    expect(missing.code).toBe(255)
    expect(missing.err).toContain('eth0: error fetching interface information: Device not found')
  })

  it('route and arp print empty tables', async () => {
    expect(await run('route -n')).toEqual({ code: 0, out: 'Kernel IP routing table\nDestination     Gateway         Genmask         Flags Metric Ref    Use Iface\n', err: '' })
    expect((await run('route add default gw 10.0.0.1')).code).toBe(1)
    expect(await run('arp -a')).toEqual({ code: 0, out: '', err: '' })
    expect((await run('arp somehost')).out).toBe('somehost (somehost) -- no entry\n')
  })

  it('blkid exits 2 with no block devices', async () => {
    expect(await run('blkid')).toEqual({ code: 2, out: '', err: '' })
  })

  it('look prints the lines that start with a string', async () => {
    expect((await run('look b /tmp/words')).out).toBe('banana\nberry\n')
    expect((await run('look -f AP /tmp/words')).out).toBe('apple\nApricot\n')
    expect((await run('look zzz /tmp/words')).code).toBe(1)
  })

  it('dc does integer and decimal arithmetic', async () => {
    expect(await dc('2 3 + p')).toBe('5\n')
    expect(await dc('3 4 - p')).toBe('-1\n')
    expect(await dc('_3 p')).toBe('-3\n')
    expect(await dc('10 3 / p')).toBe('3\n')
    expect(await dc('5k 10 3 / p')).toBe('3.33333\n')
    expect(await dc('3k 1 3 / p')).toBe('.333\n')
    expect(await dc('2k 1.5 2.25 * p')).toBe('3.37\n')
    expect(await dc('2 100 ^ p')).toBe('1267650600228229401496703205376\n')
    expect(await dc('10 3 % p')).toBe('1\n')
    expect(await dc('7 3 ~ f')).toBe('1\n2\n')
    expect(await dc('10k 2 v p')).toBe('1.4142135623\n')
    expect(await dc('4 3 5 |p 2 10 1000 |p')).toBe('4\n24\n')
  })

  it('dc keeps radixes, registers, strings and macros', async () => {
    expect(await dc('16 o 255 p')).toBe('FF\n')
    expect(await dc('16 i FF p')).toBe('255\n')
    expect(await dc('[hello]p')).toBe('hello\n')
    expect(await dc('5 sa 7 la + p')).toBe('12\n')
    expect(await dc('1 2 3 f')).toBe('3\n2\n1\n')
    expect(await dc('3 d * p')).toBe('9\n')
    expect(await dc('[1+ d 5 >a]sa 0 lax p')).toBe('5\n')
    expect(await dc('4 5 1:a 9 2:a 1;a 2;a + p')).toBe('14\n')
    expect(await dc('1p q 2p')).toBe('1\n')
  })

  it('dc reports an empty stack and goes on', async () => {
    const result = await run("dc -e '+ 7 p'")
    expect(result.err).toContain('dc: stack empty')
    expect(result.out).toBe('7\n')
  })
})
