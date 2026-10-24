import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { createPty } from '#lib/pty.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** A Web Serial port with an Arduino's ids that a test can feed, and that records what is written to it */
class FakePort {
  opened: { baudRate: number } | undefined
  /** What the port was last opened with, kept after it closes */
  last: { baudRate: number } | undefined
  opens = 0
  written: number[] = []
  private controller!: ReadableStreamDefaultController<Uint8Array>
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  async open(options: { baudRate: number }) {
    this.opened = this.last = options
    this.opens++
    this.readable = new ReadableStream({ start: controller => { this.controller = controller } })
    this.writable = new WritableStream({ write: chunk => { this.written.push(...chunk) } })
  }
  async close() { this.opened = undefined }
  getInfo() { return { usbVendorId: 0x2341, usbProductId: 0x43 } }
  async getSignals() { return { dataSetReady: true, clearToSend: true, dataCarrierDetect: false, ringIndicator: false } }
  signalsSet: unknown[] = []
  async setSignals(signals: unknown) { this.signalsSet.push(signals) }
  feed(text: string) { this.controller.enqueue(new TextEncoder().encode(text)) }
  unplug() { this.controller.error(new Error('the device has been lost')) }
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  if (!done()) throw new Error('timed out')
}

/** `/dev/ttyACM0` used by a program the way `microcom` uses it: opened, set raw at 115200, written and read */
describe('a serial port as /dev/ttyACM0', () => {
  let kernel: Kernel
  const port = new FakePort()

  beforeAll(async () => {
    Object.defineProperty(globalThis.navigator, 'serial', {
      value: { getPorts: async () => [port], addEventListener() {}, removeEventListener() {} },
      configurable: true
    })
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

  it('is there at boot, with a name under /dev/serial/by-id that stays with the device', async () => {
    const stat = await fs().stat('/dev/ttyACM0') as unknown as { rdev: number | bigint }
    expect(Number(BigInt(stat.rdev) >> 20n)).toBe(166)
    expect(await fs().readlink('/dev/serial/by-id/usb-2341_0043-if00')).toBe('../../ttyACM0')
    expect(await fs().exists('/dev/ttyS0')).toBe(false)
  })

  it('a program opens it, sets it raw at 115200, and talks to the device', async () => {
    await fs().rm('/tmp/serial-result', { force: true })
    await fs().writeFile('/tmp/serial.js', `
      const { open, close, read, write, ioctl, tcgetattr, tcsetattr } = globalThis.ecmaosSyscalls
      const enc = new TextEncoder(), dec = new TextDecoder()
      const out = []
      const fd = open('/dev/ttyACM0', 2, 0)
      const t = tcgetattr(fd)
      out.push('speed=' + (t.cflag & 0o10017).toString(8))
      // cfmakeraw, then B115200
      tcsetattr(fd, { iflag: 0, oflag: 0, lflag: 0, cflag: (t.cflag & ~0o10017) | 0o10002 })
      out.push('now=' + (tcgetattr(fd).cflag & 0o10017).toString(8))
      write(fd, enc.encode('ping\\n'))
      const buf = new Uint8Array(16)
      let heard = ''
      while (!heard.includes('pong')) heard += dec.decode(buf.subarray(0, read(fd, buf, -1)))
      out.push('heard=' + heard)
      close(fd)
      const file = open('/tmp/serial-result', 1 | 64 | 512, 0o644)
      write(file, enc.encode(out.join('|')))
      close(file)
    `, { mode: 0o755 })
    const running = kernel.shell.execute('/tmp/serial.js')
    await until(() => new TextDecoder().decode(new Uint8Array(port.written)).includes('ping\n'))
    // raw: no CR added on the way out, and the port was opened again at the new speed
    expect(port.written).toEqual([...new TextEncoder().encode('ping\n')])
    expect(port.opened?.baudRate).toBe(115200)
    port.feed('pong')
    expect(await running).toBe(0)
    expect(await fs().readFile('/tmp/serial-result', 'utf-8')).toBe('speed=15|now=10002|heard=pong')
    // the last close let the port go
    await until(() => port.opened === undefined)
  })

  it('stty -F sets the port, and the port keeps it for the next program', async () => {
    const run = async (command: string) => {
      const code = await kernel.shell.execute(`${command} > /tmp/stty.out 2> /tmp/stty.err`)
      return { code, out: await fs().readFile('/tmp/stty.out', 'utf8'), err: await fs().readFile('/tmp/stty.err', 'utf8') }
    }
    expect(await run('stty -F /dev/ttyACM0 57600 cs7 parenb -echo')).toMatchObject({ code: 0, err: '' })
    const shown = await run('stty -F /dev/ttyACM0 -a')
    expect(shown.out).toContain('speed 57600 baud')
    expect(shown.out).toMatch(/(^| )parenb .*cs7;/m)
    expect(shown.out).toContain('-echo')
    expect(port.last).toMatchObject({ baudRate: 57600, dataBits: 7, parity: 'even' })
    // what the browser cannot do is refused, and the setting stays
    expect(await run('stty -F /dev/ttyACM0 cs5')).toMatchObject({ code: 1, err: 'stty: /dev/ttyACM0: unable to perform all requested operations\n' })
    expect(await run('stty -F /dev/ttyACM0 12345')).toMatchObject({ code: 1, err: "stty: invalid argument '12345'\n" })
    expect(await run('stty -F /dev/ttyACM0 9600 cs8 -parenb echo')).toMatchObject({ code: 0 })
    expect((await run('stty -F /dev/ttyACM0')).out).toContain('speed 9600 baud')
    await until(() => port.opened === undefined)
  }, 60000)

  /** `microcom` on a terminal, as a terminal window runs it; what it writes to the terminal is collected */
  const microcom = async () => {
    const pty = createPty()
    let seen = ''
    pty.onData(data => { seen += new TextDecoder().decode(data) })
    const proc = await kernel.spawnOnPty({ username: 'root', pty, command: '/bin/microcom', args: ['-s', '115200', '/dev/ttyACM0'] })
    await until(() => seen.includes("Escape character is '^]'."))
    return { pty, proc, seen: () => seen }
  }

  it('microcom -s 115200 /dev/ttyACM0: what the board says is shown, what is typed goes to the board, ^] b sends a break', async () => {
    port.written = []
    const { pty, proc, seen } = await microcom()
    expect(port.opened?.baudRate).toBe(115200)
    port.feed('hello from the board\r\n')
    await until(() => seen().includes('hello from the board\r\n'))
    pty.write('AT\r')
    await until(() => port.written.length === 3)
    // raw both ways: CR is not turned into NL on the way in, nor NL into CR NL on the way out
    expect(new TextDecoder().decode(new Uint8Array(port.written))).toBe('AT\r')
    pty.write('\x1d')
    await until(() => seen().includes('[b]reak'))
    pty.write('b')
    await until(() => port.signalsSet.some(signals => (signals as { break?: boolean }).break === true))
    pty.write('\x1d')
    await until(() => seen().includes('[b]reak, [p]aste file, [q]uit: ') && seen().split('[b]reak').length > 2)
    pty.write('q')
    await proc.exited
    await until(() => port.opened === undefined)
    pty.close()
  }, 60000)

  it('a program that has the port open when it is unplugged reads the end of the file, and a write fails with EIO', async () => {
    await fs().writeFile('/tmp/hangup.js', `
      const { open, close, read, write } = globalThis.ecmaosSyscalls
      const fd = open('/dev/ttyACM0', 2, 0)
      const buf = new Uint8Array(16)
      const out = ['first=' + read(fd, buf, -1)]
      out.push('again=' + read(fd, buf, -1))
      try { write(fd, new Uint8Array([1])); out.push('wrote') } catch (error) { out.push(String(error.code ?? error.message)) }
      close(fd)
      const file = open('/tmp/hangup-result', 1 | 64 | 512, 0o644)
      write(file, new TextEncoder().encode(out.join('|')))
      close(file)
    `, { mode: 0o755 })
    const running = kernel.shell.execute('/tmp/hangup.js')
    await until(() => port.opened !== undefined)
    await new Promise(resolve => setTimeout(resolve, 50))
    port.unplug()
    expect(await running).toBe(0)
    expect(await fs().readFile('/tmp/hangup-result', 'utf-8')).toBe('first=0|again=0|EIO')
    expect(await fs().exists('/dev/ttyACM0')).toBe(false)
    // the next one plugged in gets the name again
    const { attachPort } = await import('@ecmaos-devices/serial')
    expect(attachPort(port as never)).toBe('ttyACM0')
  }, 60000)

  it('microcom ends when the board is unplugged, and the node goes with it', async () => {
    const { pty, proc } = await microcom()
    port.unplug()
    await proc.exited
    expect(await fs().exists('/dev/ttyACM0')).toBe(false)
    expect(await fs().exists('/dev/serial/by-id/usb-2341_0043-if00')).toBe(false)
    pty.close()
  }, 60000)
})
