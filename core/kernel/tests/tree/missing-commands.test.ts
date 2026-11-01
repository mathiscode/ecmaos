import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `ifconfig`, `route`, `arp`, `blkid`, `look`, `dc`, `ncal`, `lastlog`, `finger` and `pinky`, commands of `@ecmaos/coreutils` */
describe('network listings, blkid, look, dc, ncal, lastlog and finger', () => {
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

  it('ncal is cal laid out vertically', async () => {
    const ncal = await run('ncal 2 2026')
    expect(ncal.code).toBe(0)
    expect(ncal.out).toBe((await run('cal -v 2 2026')).out)
    expect(ncal.out).toContain('Su')
    expect((await run('ncal -M 2 2026')).out).toBe((await run('cal -v -m 2 2026')).out)
  })

  it('lastlog, finger and pinky read the login records', async () => {
    const now = Date.now()
    await kernel.filesystem.fs.writeFile('/var/log/wtmp', `boot\t\t\t${now - 90000}\nlogin\troot\ttty1\t${now - 60000}\n`)
    await kernel.filesystem.fs.writeFile('/run/utmp', `root\ttty1\t${now - 60000}\n`)

    const lastlog = await run('lastlog -u root')
    expect(lastlog.code).toBe(0)
    expect(lastlog.out).toMatch(/^Username {9}Port {5}From {13}Latest\nroot {13}tty1 {22}\w{3} \w{3} \d\d \d\d:\d\d:\d\d [+-]\d{4} \d{4}\n$/)
    expect((await run('lastlog -u nosuch')).code).toBe(1)
    expect((await run('lastlog -S -u root')).code).toBe(1)

    const finger = await run('finger root')
    expect(finger.out).toMatch(/^Login: root +Name: .*\nDirectory: .+Shell: .*\nOn since .+ on tty1\nNo mail\.\nNo Plan\.\n$/)
    expect((await run('finger')).out).toMatch(/^Login +Name +Tty +Idle +Login Time +Office +Office Phone\nroot .+tty1 .+\n$/)
    expect((await run('finger nosuch')).out).toBe('finger: nosuch: no such user.\n')

    const pinky = await run('pinky')
    expect(pinky.out).toMatch(/^Login +Name +TTY +Idle +When\nroot .+tty1 .+\n$/)
    expect((await run('pinky -f')).out).toMatch(/^root .+tty1 /)
  })

  it('getfacl and setfacl keep ACLs in the files', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/acl.txt', 'x')
    await kernel.filesystem.fs.chmod('/tmp/acl.txt', 0o640)

    expect((await run('getfacl /tmp/acl.txt')).out).toBe('# file: tmp/acl.txt\n# owner: root\n# group: root\nuser::rw-\ngroup::r--\nother::---\n\n')

    const set = await run('setfacl -m u:root:rwx,g::r-x /tmp/acl.txt')
    expect(set).toEqual({ code: 0, out: '', err: '' })
    const shown = await run('getfacl -c /tmp/acl.txt')
    expect(shown.out).toBe('user::rw-\nuser:root:rwx\ngroup::r-x\nmask::rwx\nother::---\n\n')
    expect((await kernel.filesystem.fs.stat('/tmp/acl.txt')).mode & 0o777).toBe(0o670)

    await run('setfacl -m m::r-- /tmp/acl.txt')
    expect((await run('getfacl -c /tmp/acl.txt')).out).toContain('user:root:rwx                   #effective:r--')

    await run('setfacl -x u:root /tmp/acl.txt')
    expect((await run('getfacl -c /tmp/acl.txt')).out).not.toContain('user:root')

    await run('setfacl -b /tmp/acl.txt')
    expect((await run('getfacl -c /tmp/acl.txt')).out).toBe('user::rw-\ngroup::r-x\nother::---\n\n')
    expect((await run('setfacl -m u:nosuchuser:r /tmp/acl.txt')).err).toContain('nosuchuser')
  })

  it('default ACLs belong to directories', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/acl-dir')
    expect((await run('setfacl -d -m u:root:rx /tmp/acl-dir')).code).toBe(0)
    const shown = (await run('getfacl -c /tmp/acl-dir')).out
    expect(shown).toContain('default:user:root:r-x')
    expect(shown).toContain('default:mask::rwx')
    expect((await run('setfacl -d -m u:root:rx /tmp/acl.txt')).err).toContain('Only directories can have default ACLs')
    await run('setfacl -k /tmp/acl-dir')
    expect((await run('getfacl -c /tmp/acl-dir')).out).not.toContain('default:')
  })

  it('units converts between units', async () => {
    expect(await run('units ft m')).toEqual({ code: 0, out: '\t* 0.3048\n\t/ 3.2808399\n', err: '' })
    const terse = async (have: string, want: string) => (await run(`units -t '${have}' '${want}'`)).out
    expect(await terse('tempF(212)', 'tempC')).toBe('100\n')
    expect(await terse('tempC(0)', 'tempF')).toBe('32\n')
    expect(await terse('2 hours', 'min')).toBe('120\n')
    expect(await terse('mi/hr', 'km/hr')).toBe('1.609344\n')
    expect(await terse('1|2 m', 'cm')).toBe('50\n')
    expect(await terse('1 kibibyte', 'bytes')).toBe('1024\n')
    expect(await terse('1 m^2', 'ft^2')).toBe('10.76391\n')
    expect(await terse('1 lightyear', 'km')).toBe('9.4607305e+12\n')
    expect(await terse('1 gallon', 'liters')).toBe('3.7854118\n')
    expect(await terse('1 atm', 'psi')).toBe('14.695949\n')
    const mismatch = await run('units m kg')
    expect(mismatch.code).toBe(1)
    expect(mismatch.err).toContain('conformability error')
    expect((await run('units foo m')).err).toBe("Unknown unit 'foo'\n")
  })

  it('ls -l marks a file with an extended ACL', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/marked.txt', 'x')
    await kernel.filesystem.fs.writeFile('/tmp/unmarked.txt', 'x')
    await run('setfacl -m u:root:r /tmp/marked.txt')
    const listing = (await run('ls -l /tmp/marked.txt /tmp/unmarked.txt')).out
    expect(listing).toMatch(/^\S{10}\+ .*marked\.txt$/m)
    expect(listing).toMatch(/^\S{10} \d.*unmarked\.txt$/m)
  })

  it('cp -p and tar --acls carry an ACL', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/aclcopy', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/aclcopy/a.txt', 'x')
    await run('setfacl -m u:root:r /tmp/aclcopy/a.txt')

    expect((await run('cp -p /tmp/aclcopy/a.txt /tmp/aclcopy/b.txt')).code).toBe(0)
    expect((await run('getfacl -c /tmp/aclcopy/b.txt')).out).toContain('user:root:r--')
    await run('cp /tmp/aclcopy/a.txt /tmp/aclcopy/c.txt')
    expect((await run('getfacl -c /tmp/aclcopy/c.txt')).out).not.toContain('user:root')

    expect((await run('tar --acls -cf /tmp/aclcopy/t.tar -C /tmp/aclcopy a.txt')).code).toBe(0)
    await kernel.filesystem.fs.mkdir('/tmp/aclout1')
    await kernel.filesystem.fs.mkdir('/tmp/aclout2')
    expect((await run('tar --acls -xf /tmp/aclcopy/t.tar -C /tmp/aclout1')).code).toBe(0)
    expect((await run('getfacl -c /tmp/aclout1/a.txt')).out).toContain('user:root:r--')
    await run('tar -xf /tmp/aclcopy/t.tar -C /tmp/aclout2')
    expect((await run('getfacl -c /tmp/aclout2/a.txt')).out).not.toContain('user:root')
  })

  it('dc reports an empty stack and goes on', async () => {
    const result = await run("dc -e '+ 7 p'")
    expect(result.err).toContain('dc: stack empty')
    expect(result.out).toBe('7\n')
  })
})
