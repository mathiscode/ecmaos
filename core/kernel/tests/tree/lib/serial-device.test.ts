import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Connection, memoryPair, RemoteDevice, serveDevice } from '@ecmaos/peer'
import { EPOLLIN, EPOLLOUT } from '@zenfs/linux'
import { getDrivers, openSerialSession } from '@ecmaos-devices/serial'

/** A Web Serial port that can be fed bytes and unplugged, and that records what is written to it */
class FakePort {
  opened: { baudRate: number } | undefined
  written: number[] = []
  signalsSet: unknown[] = []
  private controller!: ReadableStreamDefaultController<Uint8Array>
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  /** Set to hold back what the port accepts, as a slow line does */
  gate: Promise<void> | undefined

  async open(options: { baudRate: number }) {
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

describe('the /dev/ttyS<n> driver', () => {
  it('has only the control node where Web Serial does not exist', async () => {
    vi.stubGlobal('navigator', {})
    expect((await getDrivers({ events: { emit() {} } } as never)).map(driver => driver.name)).toEqual(['serial'])
  })

  async function node() {
    const drivers = await getDrivers({ events: { emit() {} } } as never)
    const driver = drivers.find(candidate => candidate.name === 'ttyS0')!
    const file = { devt: { major: 254, minor: driver.minor } } as never
    return { ops: driver.ops, file }
  }

  it('reads wait for the port, and a read gets what has arrived', async () => {
    const { ops, file } = await node()
    ops.open!(file)
    // still opening: nothing to read, and not yet writable
    expect(ops.poll!(file)).toBe(0)
    await tick()
    expect(port.opened?.baudRate).toBe(9600)
    expect(ops.poll!(file) & EPOLLIN).toBe(0)
    expect(ops.poll!(file) & EPOLLOUT).toBe(EPOLLOUT)

    expect(ops.poll_wait!(file)).toBeDefined()
    port.feed(5, 6, 7, 8)
    await tick()
    expect(ops.poll!(file) & EPOLLIN).toBe(EPOLLIN)
    const into = new Uint8Array(3)
    expect(ops.read!(file, into, 0, 3)).toBe(3)
    expect([...into]).toEqual([5, 6, 7])
    expect(ops.read!(file, into, 0, 3)).toBe(1)
    expect(ops.poll!(file) & EPOLLIN).toBe(0)
    ops.release!(file)
  })

  it('a write reaches the port in order and takes only what the port has room for', async () => {
    const { ops, file } = await node()
    ops.open!(file)
    await tick()
    const buffer = new Uint8Array([1, 2, 3])
    expect(ops.write!(file, buffer, 0)).toBe(3)
    buffer.fill(0)
    await tick()
    expect(port.written).toEqual([1, 2, 3])

    let release!: () => void
    port.gate = new Promise(resolve => { release = resolve })
    const big = new Uint8Array(100 * 1024).fill(7)
    const taken = ops.write!(file, big, 0)
    expect(taken).toBe(64 * 1024)
    expect(ops.poll!(file) & EPOLLOUT).toBe(0)
    expect(() => ops.write!(file, big, 0)).toThrow(/temporarily unavailable/i)
    release()
    await tick(20)
    expect(ops.poll!(file) & EPOLLOUT).toBe(EPOLLOUT)
    ops.release!(file)
  })

  it('an unplugged port reads as the end of the file once drained, and a write fails', async () => {
    const { ops, file } = await node()
    ops.open!(file)
    await tick()
    port.feed(1)
    await tick()
    port.unplug()
    await tick()
    const into = new Uint8Array(4)
    expect(ops.poll!(file) & EPOLLIN).toBe(EPOLLIN)
    expect(ops.read!(file, into, 0, 4)).toBe(1)
    expect(() => ops.read!(file, into, 0, 4)).toThrow(/lost|EIO|I\/O/i)
    expect(() => ops.write!(file, new Uint8Array(1), 0)).toThrow()
    ops.release!(file)
  })
})
