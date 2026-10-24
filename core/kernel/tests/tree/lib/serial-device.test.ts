import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Connection, memoryPair, RemoteDevice, serveDevice } from '@ecmaos/peer'
import { acmDriver, attachPort, detachPort, getTTYDrivers, lineName, openSerialSession, rfcommDriver, speedOf, supportedCflag, usbSerialDriver } from '@ecmaos-devices/serial'

/** A Web Serial port that can be fed bytes and unplugged, and that records what is written to it */
class FakePort {
  opened: { baudRate: number, [key: string]: unknown } | undefined
  written: number[] = []
  signalsSet: unknown[] = []
  private controller!: ReadableStreamDefaultController<Uint8Array>
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  /** Set to hold back what the port accepts, as a slow line does */
  gate: Promise<void> | undefined

  async open(options: { baudRate: number, [key: string]: unknown }) {
    this.opened = options
    this.readable = new ReadableStream({ start: controller => { this.controller = controller } })
    this.writable = new WritableStream({ write: async chunk => { await this.gate; this.written.push(...chunk) } })
  }
  async close() { this.opened = undefined }
  getInfo() { return { usbVendorId: 0x2341, usbProductId: 0x43 } }
  async getSignals() { return { dataSetReady: true, clearToSend: false, dataCarrierDetect: false, ringIndicator: false } }
  async setSignals(signals: unknown) { this.signalsSet.push(signals) }
  feed(...bytes: number[]) { this.controller.enqueue(new Uint8Array(bytes)) }
  unplug() { this.controller.error(new Error('the device has been lost')) }
  end() { this.controller.close() }
}

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

let port: FakePort
beforeEach(() => {
  port = new FakePort()
  vi.stubGlobal('navigator', { serial: { getPorts: async () => [port], addEventListener() {}, removeEventListener() {} } })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('a serial port as a device session', () => {
  it('opens at the given speed, reads, writes and answers controls', async () => {
    const session = await openSerialSession(port as never, { baudRate: 115200 })
    expect(port.opened?.baudRate).toBe(115200)
    expect(session.info).toMatchObject({ kind: 'serial', read: true, write: true, baudRate: 115200, usbVendorId: 0x2341 })
    port.feed(1, 2, 3)
    expect([...(await session.read())!]).toEqual([1, 2, 3])
    await session.write(new Uint8Array([9, 8]))
    expect(port.written).toEqual([9, 8])
    expect(await session.control('signals', [])).toEqual({ dsr: true, cts: false, dcd: false, ri: false })
    await session.control('set-signals', [{ dtr: true, rts: false }])
    expect(port.signalsSet).toEqual([{ dataTerminalReady: true, requestToSend: false }])
    await expect(session.control('set-signals', [{ dtr: 'yes' }])).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(session.control('format-disk', [])).rejects.toMatchObject({ code: 'ENOSYS' })
    await expect(openSerialSession(port as never, { baudRate: 3 })).rejects.toMatchObject({ code: 'EINVAL' })
    port.end()
    expect(await session.read()).toBeUndefined()
    await session.close()
  })

  it('served over a device channel to another machine', async () => {
    const [a, b] = memoryPair()
    const client = new Connection(a, { role: 'client' })
    const server = new Connection(b, { role: 'server' })
    const session = await openSerialSession(port as never)
    server.accept('device', channel => serveDevice(channel, session as never))
    const remote = new RemoteDevice(await client.open('device'))
    expect(await remote.info()).toMatchObject({ kind: 'serial', baudRate: 9600 })
    port.feed(65, 66)
    await tick()
    const into = new Uint8Array(8)
    expect(remote.take(into)).toBe(2)
    expect(remote.write(new Uint8Array([67]))).toBe(1)
    await tick()
    expect(port.written).toEqual([67])
    expect(await remote.control('signals')).toMatchObject({ dsr: true })
    // unplugging ends the channel, with the reason
    port.unplug()
    await remote.channel.done
    expect(remote.channel.error?.message).toMatch(/lost/)
  })
})

describe('serial ports as terminals', () => {
  const ctx = { events: { emit() {} }, log: { warn() {}, debug() {}, info() {} } } as never
  const encoder = new TextEncoder()
  const text = (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes))
  const TCGETS = 0x5401, TCSETS = 0x5402
  const lflag = { ISIG: 1, ICANON: 2, ECHO: 8 }

  /** A port with these USB ids (none for a Bluetooth one) */
  const portWith = (vendor?: number, product = 1) => Object.assign(new FakePort(), { getInfo: () => vendor === undefined ? {} : { usbVendorId: vendor, usbProductId: product } })

  /** The file a program would have open on line `name`, and the driver's operations */
  const fileOf = (name: string) => {
    const driver = [acmDriver, usbSerialDriver, rfcommDriver].find(candidate => name.startsWith(candidate.name))!
    const file = { devt: { major: driver.major, minor: Number(name.slice(driver.name.length)) } } as never
    const ops = driver.fops
    const ioctl = (request: number, arg?: unknown) => ops.ioctl![request]!({} as never, file, arg)
    const read = (count = 64) => { const into = new Uint8Array(count); const n = ops.read!(file, into, 0, count) as number; return [...into.subarray(0, n)] }
    return { file, ops, ioctl, read, write: (data: string) => ops.write!(file, encoder.encode(data), 0) }
  }

  const ports: FakePort[] = []
  const plug = (port: FakePort) => { ports.push(port); return attachPort(port as never) }
  afterEach(() => { for (const port of ports.splice(0)) detachPort(port as never) })

  it('names a port by what it is: a CDC ACM board, a USB-serial bridge, a Bluetooth port', async () => {
    const granted = portWith(0x2341)
    vi.stubGlobal('navigator', { serial: { getPorts: async () => [granted], addEventListener() {}, removeEventListener() {} } })
    expect((await getTTYDrivers(ctx)).map(driver => driver.name)).toEqual(['ttyACM', 'ttyUSB', 'rfcomm'])
    // a port the browser had already granted has its line from the start
    expect(lineName(granted as never)).toBe('ttyACM0')
    detachPort(granted as never)
    expect(plug(portWith(0x2341))).toBe('ttyACM0')
    expect(plug(portWith(0x2e8a))).toBe('ttyACM1')
    expect(plug(portWith(0x0403, 0x6001))).toBe('ttyUSB0')
    expect(plug(portWith(0x1a86))).toBe('ttyUSB1')
    expect(plug(portWith())).toBe('rfcomm0')
    expect([acmDriver.major, usbSerialDriver.major, rfcommDriver.major]).toEqual([166, 188, 216])
  })

  it('takes the lowest free number, as Linux does, once a port has gone', () => {
    const first = portWith(0x2341)
    expect(plug(first)).toBe('ttyACM0')
    expect(plug(portWith(0x2341))).toBe('ttyACM1')
    detachPort(first as never)
    expect(plug(portWith(0x239a))).toBe('ttyACM0')
  })

  it('is a terminal: canonical and echoing until it is set raw, at 9600 to start', async () => {
    const port = portWith(0x2341)
    const line = fileOf(plug(port))
    line.ops.open!(line.file)
    await tick()
    expect(port.opened).toMatchObject({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' })
    expect(speedOf(line.ioctl(TCGETS).cflag)).toBe(9600)
    port.feed(...encoder.encode('ab'))
    await tick()
    // no line yet, and what came in was echoed back to the device
    expect(line.read()).toEqual([])
    port.feed(0x0d)
    await tick()
    expect(text(line.read())).toBe('ab\n')
    expect(text(port.written)).toBe('ab\r\n')
    line.ops.release!(line.file)
  })

  it('a raw line at 115200: the port opens again at the new speed, and nothing read before is lost', async () => {
    const port = portWith(0x2341)
    const line = fileOf(plug(port))
    line.ops.open!(line.file)
    await tick()
    const termios = line.ioctl(TCGETS)
    line.ioctl(TCSETS, { ...termios, iflag: 0, oflag: 0, lflag: 0 })
    port.feed(1, 2)
    await tick()
    // B115200 | CS8 | CREAD | CLOCAL, two stop bits, odd parity, RTS/CTS
    line.ioctl(TCSETS, { ...line.ioctl(TCGETS), cflag: (0o10002 | 0o60 | 0o200 | 0o4000 | 0o100 | 0o400 | 0o1000 | 0o20000000000) >>> 0 })
    await tick()
    expect(port.opened).toMatchObject({ baudRate: 115200, stopBits: 2, parity: 'odd', flowControl: 'hardware' })
    port.feed(3)
    await tick()
    expect(line.read()).toEqual([1, 2, 3])
    line.write('\n')
    await tick()
    expect(port.written).toEqual([0x0a])
    line.ops.release!(line.file)
  })

  it('keeps what the browser cannot do as it was, and says so in TCGETS', async () => {
    const port = portWith(0x0403)
    const line = fileOf(plug(port))
    line.ops.open!(line.file)
    await tick()
    const before = line.ioctl(TCGETS).cflag
    // CS5 and BOTHER (a speed given in c_ospeed, which TCSETS cannot carry)
    line.ioctl(TCSETS, { ...line.ioctl(TCGETS), cflag: (before & ~0o10077) | 0o10000 })
    await tick()
    expect(line.ioctl(TCGETS).cflag).toBe(before)
    expect(port.opened?.baudRate).toBe(9600)
    expect(supportedCflag(0o40 | 0o15, 0o60 | 0o15)).toBe(0o40 | 0o15)
    line.ops.release!(line.file)
  })

  it('answers for the modem lines and sends a break', async () => {
    const port = portWith(0x2341)
    const line = fileOf(plug(port))
    line.ops.open!(line.file)
    await tick()
    expect(port.signalsSet).toEqual([{ dtr: true, rts: true }].map(({ dtr, rts }) => ({ dataTerminalReady: dtr, requestToSend: rts })))
    line.ioctl(0x5415)
    await tick()
    // TIOCM_DTR | TIOCM_RTS | TIOCM_DSR (the fake port's DSR is up)
    expect(line.ioctl(0x5415)).toBe(0x002 | 0x004 | 0x100)
    line.ioctl(0x5417, 0x002) // TIOCMBIC DTR
    await tick()
    expect(port.signalsSet.at(-1)).toEqual({ dataTerminalReady: false, requestToSend: true })
    line.ioctl(0x5409, 1) // TCSBRK 1 is tcdrain: no break
    line.ioctl(0x5409, 0)
    await tick(300)
    expect(port.signalsSet.slice(-2)).toEqual([{ break: true }, { break: false }])
    line.ops.release!(line.file)
  })

  it('an unplugged port hangs its line up: the node goes, reads end, writes fail, and the number is free once closed', async () => {
    const port = portWith(0x2341)
    const name = plug(port)
    const line = fileOf(name)
    line.ops.open!(line.file)
    await tick()
    port.unplug()
    await tick()
    expect(line.read()).toEqual([])
    expect(line.read()).toEqual([])
    expect(() => line.write('x')).toThrow(expect.objectContaining({ code: 'EIO' }))
    expect(lineName(port as never)).toBeUndefined()
    // still held, so the number is not given out
    expect(plug(portWith(0x2341))).toBe('ttyACM1')
    line.ops.release!(line.file)
    await tick()
    expect(plug(portWith(0x2341))).toBe(name)
  })
})
