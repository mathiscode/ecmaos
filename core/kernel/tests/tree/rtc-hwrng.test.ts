import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { rtcTime } from '#lib/rtc.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `/dev/rtc0` and `/dev/hwrng`: the browser's clock and random source, at the names and numbers Linux gives them */
describe('the real-time clock and the hardware random number generator', () => {
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
  })

  const fs = () => kernel.filesystem.fs
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/rtc.out 2> /tmp/rtc.err`)
    return { code, out: await fs().readFile('/tmp/rtc.out', 'utf8'), err: await fs().readFile('/tmp/rtc.err', 'utf8') }
  }
  const node = async (path: string) => {
    const stat = await fs().stat(path) as unknown as { mode: number, rdev: number | bigint }
    return { mode: stat.mode & 0o7777, major: Number(BigInt(stat.rdev) >> 20n), minor: Number(BigInt(stat.rdev) & 0xfffffn) }
  }

  it('has the nodes, for root only, /dev/rtc as a link, and the sysfs attributes', async () => {
    expect(await node('/dev/hwrng')).toEqual({ mode: 0o600, major: 10, minor: 183 })
    expect(await node('/dev/rtc0')).toMatchObject({ mode: 0o600, minor: 0 })
    expect(await fs().readlink('/dev/rtc')).toBe('rtc0')
    const sysfs = async (path: string) => await fs().readFile(path, 'utf8')
    const rtc0 = '/sys/devices/virtual/rtc/rtc0'
    expect(await sysfs(`${rtc0}/date`)).toBe(new Date().toISOString().slice(0, 10) + '\n')
    expect(await sysfs(`${rtc0}/name`)).toBe('rtc-browser\n')
    expect(Math.abs(Number(await sysfs(`${rtc0}/since_epoch`)) - Date.now() / 1000)).toBeLessThan(5)
    expect(await sysfs(`${rtc0}/hctosys`)).toBe('1\n')
    expect(await sysfs('/sys/devices/virtual/misc/hw_random/rng_current')).toBe('webcrypto\n')
    // through the class's link, and with cat, as a user reads them
    expect(await fs().readlink('/sys/class/rtc/rtc0')).toBe('../../devices/virtual/rtc/rtc0')
    expect((await run('cat /sys/class/rtc/rtc0/name /sys/class/misc/hw_random/rng_available')).out).toBe('rtc-browser\nwebcrypto\n')
  })

  it('struct rtc_time is the time in UTC, months from 0 and years from 1900', () => {
    const view = new DataView(rtcTime(new Date(Date.UTC(2026, 9, 24, 13, 5, 9))).buffer)
    const fields = Array.from({ length: 9 }, (_, i) => view.getInt32(i * 4, true))
    // sec, min, hour, mday, mon, year, wday (a Saturday), yday, isdst
    expect(fields).toEqual([9, 5, 13, 24, 9, 126, 6, 296, 0])
  })

  it('/dev/hwrng gives as many random bytes as are asked for', async () => {
    expect((await run('head -c 70000 /dev/hwrng > /tmp/r1; head -c 70000 /dev/hwrng > /tmp/r2; wc -c < /tmp/r1')).out.trim()).toBe('70000')
    const [a, b] = await Promise.all([fs().readFile('/tmp/r1'), fs().readFile('/tmp/r2')])
    expect(a.length).toBe(70000)
    expect(a.every((byte, i) => byte === b[i])).toBe(false)
    // past the first 64 KiB too
    expect(a.subarray(65536).some(byte => byte !== 0)).toBe(true)
  })

  it('hwclock reads the clock, and cannot set it', async () => {
    const shown = await run('hwclock')
    expect(shown).toMatchObject({ code: 0, err: '' })
    expect(shown.out).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\+0000\n$/)
    expect(Math.abs(Date.parse(shown.out.trim().replace(' ', 'T').replace('+0000', 'Z')) - Date.now())).toBeLessThan(5000)
    expect((await run('hwclock -r -f /dev/rtc')).code).toBe(0)
    const set = await run('hwclock -w')
    expect(set.code).not.toBe(0)
    expect(set.err).toMatch(/Invalid argument/)
    // nor set the system clock from it
    expect((await run('hwclock -s')).code).not.toBe(0)
  }, 60000)

  it('with the update interrupt on, a read waits for the next second; with O_NONBLOCK it does not wait', async () => {
    await fs().writeFile('/tmp/uie.js', `
      const { open, close, read, write, ioctl } = globalThis.ecmaosSyscalls
      const out = []
      const fd = open('/dev/rtc0', 0, 0)
      const buf = new Uint8Array(4)
      ioctl(fd, 0x7003) // RTC_UIE_ON
      const times = []
      for (let i = 0; i < 2; i++) {
        read(fd, buf, -1)
        times.push(Date.now())
        out.push((new DataView(buf.buffer).getUint32(0, true) & 0xff).toString(16))
      }
      out.push(times[1] - times[0] > 700 ? 'a second apart' : 'too soon: ' + (times[1] - times[0]))
      // the second began within a few milliseconds of the read's end
      out.push(times[1] % 1000 < 200 ? 'on the second' : 'off: ' + (times[1] % 1000))
      ioctl(fd, 0x7004)
      close(fd)
      const nb = open('/dev/rtc0', 0o4000, 0)
      try { read(nb, buf, -1); out.push('read') } catch (error) { out.push(String(error.code ?? error.message)) }
      close(nb)
      const file = open('/tmp/uie-result', 1 | 64 | 512, 0o644)
      write(file, new TextEncoder().encode(out.join('|')))
      close(file)
    `, { mode: 0o755 })
    expect(await kernel.shell.execute('/tmp/uie.js')).toBe(0)
    expect(await fs().readFile('/tmp/uie-result', 'utf8')).toBe('90|90|a second apart|on the second|EAGAIN')
  }, 30000)
})
