import { afterEach, describe, expect, it, vi } from 'vitest'

import { EPOLLIN, EPOLLOUT } from '@zenfs/linux'
import { openBatterySession, batteryRecord } from '@ecmaos-devices/battery'
import { openBluetoothSession } from '@ecmaos-devices/bluetooth'
import { openCameraSession, frameOf } from '@ecmaos-devices/camera'
import { fromPcm16, openMicrophoneSession, openSpeakerSession, toPcm16 } from '@ecmaos-devices/audio'
import { openGeoSession } from '@ecmaos-devices/geo'
import { openSensorSession } from '@ecmaos-devices/sensors'
import { openUsbSession } from '@ecmaos-devices/usb'
import { Feed, sessionOperations } from '@ecmaos-devices/session'
import { openLocalDevice } from '../../../src/tree/lib/remote-device.js'

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)
afterEach(() => { vi.unstubAllGlobals() })

describe('a feed', () => {
  it('drops the oldest past its limit and ends after what is queued', async () => {
    const feed = new Feed(2)
    feed.push(new Uint8Array([1])); feed.push(new Uint8Array([2])); feed.push(new Uint8Array([3]))
    feed.end()
    expect([...(await feed.next())!]).toEqual([2])
    expect([...(await feed.next())!]).toEqual([3])
    expect(await feed.next()).toBeUndefined()
    feed.push(new Uint8Array([9]))
    expect(feed.length).toBe(0)
  })
})

describe('a /dev node made from a session', () => {
  const file = (minor: number) => ({ devt: { major: 250, minor } }) as never

  it('reads wait for the device, writes are handed on, and the last close ends the session', async () => {
    const written: number[][] = []
    let closed = 0
    const feeds: Feed[] = []
    const ops = sessionOperations({
      async open() {
        const feed = new Feed()
        feeds.push(feed)
        return { info: { kind: 'test', read: true, write: true }, read: () => feed.next(), async write(data) { written.push([...data]) }, close() { closed++; feed.end() } }
      }
    })
    ops.open!(file(1)); ops.open!(file(1))
    await tick()
    expect(ops.poll!(file(1)) & EPOLLIN).toBe(0)
    expect(ops.poll!(file(1)) & EPOLLOUT).toBe(EPOLLOUT)
    expect(ops.poll_wait!(file(1))).toBeDefined()
    feeds[0]!.push(new Uint8Array([1, 2, 3, 4]))
    await tick()
    expect(ops.poll!(file(1)) & EPOLLIN).toBe(EPOLLIN)
    const into = new Uint8Array(3)
    expect(ops.read!(file(1), into, 0, 3)).toBe(3)
    expect(ops.read!(file(1), into, 0, 3)).toBe(1)
    expect(ops.write!(file(1), new Uint8Array([7, 8]), 0)).toBe(2)
    await tick()
    expect(written).toEqual([[7, 8]])
    // two opens share one session, which ends with the second close
    ops.release!(file(1))
    expect(closed).toBe(0)
    ops.release!(file(1))
    expect(closed).toBe(1)
    expect(feeds.length).toBe(1)
  })

  it('a device that cannot be written to refuses writes, and a failed open reads as an error', async () => {
    const ops = sessionOperations({
      async open(minor) {
        if (minor === 2) throw new Error('unplugged')
        const feed = new Feed()
        return { info: { kind: 'test', read: true, write: false }, read: () => feed.next(), close() { feed.end() } }
      }
    })
    ops.open!(file(1))
    await tick()
    expect(() => ops.write!(file(1), new Uint8Array([1]), 0)).toThrow(/cannot be written/)
    expect(ops.poll!(file(1)) & EPOLLOUT).toBe(0)
    ops.open!(file(2))
    await tick()
    expect(() => ops.read!(file(2), new Uint8Array(1), 0, 1)).toThrow(/unplugged/)
    expect(ops.poll!(file(2)) & EPOLLIN).toBe(EPOLLIN)
  })
})

class FakeBattery extends EventTarget { level = 0.5; charging = false; chargingTime = Infinity; dischargingTime = 3600 }

describe('the battery as a session', () => {
  it('sends a record on open and on every change', async () => {
    const battery = new FakeBattery()
    const session = await openBatterySession(battery as never)
    const first = (await session.read!())!
    expect(first.length).toBe(18)
    expect(first[0]).toBe(50)
    expect(new DataView(first.buffer, first.byteOffset).getFloat64(2, true)).toBe(Infinity)
    battery.level = 0.51
    battery.charging = true
    battery.dispatchEvent(new Event('levelchange'))
    expect((await session.read!())![0]).toBe(51)
    expect(batteryRecord(battery as never)[1]).toBe(1)
    expect(await session.control!('status', [])).toMatchObject({ level: 0.51, charging: true, chargingTime: null, dischargingTime: 3600 })
    session.close()
    expect(await session.read!()).toBeUndefined()
  })
})

describe('geolocation as a session', () => {
  it('sends a JSON line per fix, answers position, and fails the reader when refused', async () => {
    let watcher: ((position: unknown) => void) | undefined
    let failer: ((error: { code: number, message: string }) => void) | undefined
    let cleared: number | undefined
    const fix = (latitude: number) => ({ timestamp: 5, coords: { latitude, longitude: 2, accuracy: 3, altitude: null, altitudeAccuracy: null, heading: null, speed: null } })
    const geolocation = {
      watchPosition: (ok: never, fail: never) => { watcher = ok; failer = fail; return 7 },
      clearWatch: (id: number) => { cleared = id },
      getCurrentPosition: (ok: (position: unknown) => void) => ok(fix(9))
    }
    const session = await openGeoSession(geolocation as never)
    watcher!(fix(1))
    expect(JSON.parse(text(await session.read!()))).toMatchObject({ t: 5, latitude: 1, longitude: 2, altitude: null })
    expect(await session.control!('position', [])).toMatchObject({ latitude: 9 })
    const events: string[] = []
    session.emit = name => { events.push(name) }
    failer!({ code: 2, message: 'no fix' })
    expect(events).toEqual(['error'])
    failer!({ code: 1, message: 'denied' })
    await expect(session.read!()).rejects.toMatchObject({ code: 'EACCES' })
    session.close()
    expect(cleared).toBe(7)
  })
})

describe('sensors as sessions', () => {
  class FakeSensor extends EventTarget {
    static last: FakeSensor
    activated = false; hasReading = false; timestamp = 10; x = 0; y = 0; z = 9.8
    stopped = false
    constructor(readonly options: { frequency: number }) { super(); FakeSensor.last = this }
    start() { this.activated = true }
    stop() { this.stopped = true }
  }
  const permissions = (state: string) => ({ query: async () => ({ state }) })

  it('sends a JSON line per reading, clamps the rate and stops with the session', async () => {
    const session = await openSensorSession('accelerometer', { scope: { Accelerometer: FakeSensor }, permissions: permissions('granted'), frequency: 500 })
    expect(FakeSensor.last.options.frequency).toBe(60)
    expect(session.info).toMatchObject({ kind: 'sensor', sensor: 'accelerometer', fields: ['x', 'y', 'z'] })
    FakeSensor.last.dispatchEvent(new Event('reading'))
    expect(JSON.parse(text(await session.read!()))).toEqual({ t: 10, x: 0, y: 0, z: 9.8 })
    expect(await session.control!('info', [])).toMatchObject({ sensor: 'accelerometer', activated: true })
    session.close()
    expect(FakeSensor.last.stopped).toBe(true)
  })

  it('says what is missing', async () => {
    await expect(openSensorSession('accelerometer', { scope: {}, permissions: permissions('granted') })).rejects.toMatchObject({ code: 'ENODEV' })
    await expect(openSensorSession('accelerometer', { scope: { Accelerometer: FakeSensor }, permissions: permissions('denied') })).rejects.toMatchObject({ code: 'EACCES' })
    await expect(openSensorSession('barometer', { scope: {} })).rejects.toMatchObject({ code: 'EINVAL' })
  })
})

class FakeUsb extends EventTarget {
  opened = false; vendorId = 0x2341; productId = 0x43; productName = 'Board'; manufacturerName = 'Acme'; serialNumber = '1'
  usbVersionMajor = 2; usbVersionMinor = 0; deviceClass = 255; deviceSubclass = 0; deviceProtocol = 0
  configuration: unknown = null
  claimed: number[] = []
  inQueue: Array<{ status: string, data?: DataView }> = []
  out: number[][] = []
  waiting: Array<(value: unknown) => void> = []
  async open() { this.opened = true }
  async close() { this.opened = false; for (const w of this.waiting) w(Promise.reject(new Error('closed'))) }
  async selectConfiguration(value: number) { this.configuration = { configurationValue: value, interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [{ endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 8 }, { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 8 }] } }] } }
  async claimInterface(n: number) { this.claimed.push(n) }
  async releaseInterface() {}
  async transferIn() {
    const next = this.inQueue.shift()
    if (next) return next
    return await new Promise(resolve => { this.waiting.push(resolve) })
  }
  async transferOut(_number: number, data: Uint8Array) { this.out.push([...data]); return { status: 'ok', bytesWritten: data.length } }
  async controlTransferIn() { return { status: 'ok', data: new DataView(new Uint8Array([1, 2]).buffer) } }
  async controlTransferOut(_setup: unknown, data?: Uint8Array) { return { status: 'ok', bytesWritten: data?.length ?? 0 } }
  async clearHalt() {}
  async selectAlternateInterface() {}
  async reset() {}
  push(...bytes: number[]) { const next = { status: 'ok', data: new DataView(new Uint8Array(bytes).buffer) }; const waiter = this.waiting.shift(); if (waiter) waiter(next); else this.inQueue.push(next) }
}

describe('a USB device as a session', () => {
  it('streams its endpoints and runs control transfers', async () => {
    const usb = new FakeUsb()
    const session = await openUsbSession(usb as never, { in: 1, out: 2 })
    expect(usb.configuration).toMatchObject({ configurationValue: 1 })
    expect(usb.claimed).toEqual([0])
    expect(session.info).toMatchObject({ kind: 'usb', read: true, write: true, vendorId: 0x2341, in: 1, out: 2 })
    usb.push(5, 6, 7)
    expect([...(await session.read!())!]).toEqual([5, 6, 7])
    await session.write!(new Uint8Array([1, 2, 3]))
    expect(usb.out).toEqual([[1, 2, 3]])
    expect([...(await session.control!('control-in', [{ type: 'vendor', recipient: 'device', request: 1 }, 2]) as Uint8Array)]).toEqual([1, 2])
    expect(await session.control!('control-out', [{ type: 'class', recipient: 'interface', request: 9, value: 1, index: 0 }, new Uint8Array([4])])).toBe(1)
    await expect(session.control!('control-in', [{ type: 'bogus', recipient: 'device', request: 1 }, 2])).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(session.control!('control-in', [{ type: 'vendor', recipient: 'device', request: 999 }, 2])).rejects.toMatchObject({ code: 'EINVAL' })
    expect(await session.control!('info', [])).toMatchObject({ configuration: 1, endpoints: [{ number: 1, direction: 'in', packetSize: 8 }, { number: 2 }] })
    await session.close()
    expect(usb.opened).toBe(false)
    expect(await session.read!()).toBeUndefined()
  })

  it('has no reads without an IN endpoint', async () => {
    const session = await openUsbSession(new FakeUsb() as never, { out: 2 })
    expect(session.read).toBeUndefined()
    expect(session.info).toMatchObject({ read: false, write: true })
    await session.close()
  })
})

class FakeCharacteristic extends EventTarget {
  value: DataView | null = null
  written: number[][] = []
  started = false
  properties: Record<string, boolean>
  constructor(readonly uuid: string, properties: Record<string, boolean> = {}) { super(); this.properties = properties }
  async startNotifications() { this.started = true; return this }
  async stopNotifications() { this.started = false; return this }
  async readValue() { return new DataView(new Uint8Array([9, 9]).buffer) }
  async writeValueWithResponse(data: Uint8Array) { this.written.push([...data]) }
  async writeValueWithoutResponse(data: Uint8Array) { this.written.push([...data]) }
  notify(...bytes: number[]) { this.value = new DataView(new Uint8Array(bytes).buffer); this.dispatchEvent(new Event('characteristicvaluechanged')) }
}

class FakeBluetooth extends EventTarget {
  name = 'Sensor'; id = 'abc'
  tx = new FakeCharacteristic('tx', { notify: true })
  rx = new FakeCharacteristic('rx', { writeWithoutResponse: true })
  connected = false
  gatt = {
    connected: false,
    connect: async () => { this.gatt.connected = true; return this.server },
    disconnect: () => { this.gatt.connected = false; this.dispatchEvent(new Event('gattserverdisconnected')) }
  }
  server = {
    getPrimaryService: async (name: string) => { if (name !== 'uart') throw new Error('no service'); return { getCharacteristic: async (c: string) => c === 'tx' ? this.tx : this.rx, getCharacteristics: async () => [this.tx, this.rx] } },
    getPrimaryServices: async () => [{ uuid: 'uart' }]
  }
}

describe('a Bluetooth device as a session', () => {
  it('is a byte stream over two characteristics, written in pieces', async () => {
    const device = new FakeBluetooth()
    const session = await openBluetoothSession(device as never, { service: 'uart', notify: 'tx', write: 'rx', chunk: 4 })
    expect(device.tx.started).toBe(true)
    device.tx.notify(1, 2)
    expect([...(await session.read!())!]).toEqual([1, 2])
    await session.write!(new Uint8Array([1, 2, 3, 4, 5, 6]))
    expect(device.rx.written).toEqual([[1, 2, 3, 4], [5, 6]])
    session.close()
    expect(device.gatt.connected).toBe(false)
    expect(await session.read!()).toBeUndefined()
  })

  it('reaches any characteristic by controls and reports subscriptions as events', async () => {
    const device = new FakeBluetooth()
    const session = await openBluetoothSession(device as never)
    expect(session.read).toBeUndefined()
    expect(await session.control!('services', [])).toEqual(['uart'])
    expect(await session.control!('characteristics', ['uart'])).toMatchObject([{ uuid: 'tx', notify: true }, { uuid: 'rx' }])
    expect([...(await session.control!('read', ['uart', 'tx']) as Uint8Array)]).toEqual([9, 9])
    await session.control!('write', ['uart', 'rx', new Uint8Array([3])])
    expect(device.rx.written).toEqual([[3]])
    const events: unknown[] = []
    session.emit = (name, data) => { events.push([name, data]) }
    await session.control!('subscribe', ['uart', 'tx'])
    device.tx.notify(8)
    expect(events).toEqual([['notify', { characteristic: 'tx', value: new Uint8Array([8]) }]])
    await session.control!('unsubscribe', ['uart', 'tx'])
    device.tx.notify(9)
    expect(events.length).toBe(1)
    await expect(session.control!('read', [])).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(openBluetoothSession(device as never, { notify: 'tx' })).rejects.toMatchObject({ code: 'EINVAL' })
    expect(device.gatt.connected).toBe(false)
  })
})

describe('audio as sessions', () => {
  it('converts samples to and from 16 bit', () => {
    const pcm = toPcm16(new Float32Array([0, 1, -1, 2]))
    expect([...new Int16Array(pcm.buffer)]).toEqual([0, 32767, -32768, 32767])
    expect([...fromPcm16(new Uint8Array([0, 0x40, 1]))]).toEqual([0.5])
  })

  function fakeEnvironment() {
    const played: Array<{ length: number, at: number }> = []
    const stopped: boolean[] = []
    const state = { processor: undefined as undefined | { onaudioprocess: ((event: unknown) => void) | null }, currentTime: 0, volume: 1 }
    const context = {
      sampleRate: 16000, state: 'running', currentTime: 0, destination: {},
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createScriptProcessor: () => { const processor = { onaudioprocess: null, connect() {}, disconnect() {} }; state.processor = processor; return processor },
      createGain: () => ({ gain: { value: 1 }, connect() {} }),
      createBuffer: (_c: number, length: number) => ({ length, copyToChannel() {} }),
      createBufferSource: () => { const node = { buffer: null as unknown as { length: number }, connect() {}, start(at: number) { played.push({ length: node.buffer.length, at }) } }; return node },
      resume: async () => {}, close: async () => {}
    }
    const environment = {
      createContext: () => context as never,
      getUserMedia: async () => ({ getAudioTracks: () => [{ addEventListener() {} }], getTracks: () => [{ stop: () => stopped.push(true) }] }) as never
    }
    return { environment, state, played, stopped, context }
  }

  it('the microphone reads samples and releases the stream', async () => {
    const { environment, state, stopped } = fakeEnvironment()
    const session = await openMicrophoneSession({ environment, rate: 8000 })
    expect(session.info).toMatchObject({ kind: 'audio-in', rate: 8000, format: 's16le', write: false })
    state.processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5]) } })
    expect([...new Int16Array((await session.read!())!.buffer)]).toEqual([16384, -16384])
    await session.close()
    expect(stopped).toEqual([true])
    expect(await session.read!()).toBeUndefined()
    await expect(openMicrophoneSession({ environment, rate: 5 })).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('the speakers queue what is written, keep an odd byte for later and take a volume', async () => {
    const { environment, played, context } = fakeEnvironment()
    const session = await openSpeakerSession({ environment })
    await session.write!(new Uint8Array([0, 0, 1]))
    expect(played).toEqual([{ length: 1, at: 0 }])
    await session.write!(new Uint8Array([0]))
    context.currentTime = 0
    expect(played.length).toBe(2)
    expect(played[1]!.at).toBeCloseTo(1 / 16000)
    await session.control!('volume', [0.25])
    expect(await session.control!('info', [])).toMatchObject({ volume: 0.25 })
    await expect(session.control!('volume', [3])).rejects.toMatchObject({ code: 'EINVAL' })
    await session.close()
    await expect(session.write!(new Uint8Array([0, 0]))).rejects.toMatchObject({ code: 'ENODEV' })
  })

  it('stereo speakers split interleaved frames into two channels and keep a partial frame for later', async () => {
    const made: Array<{ channels: number, length: number, planes: number[][] }> = []
    const context = {
      sampleRate: 48000, state: 'running', currentTime: 0, destination: {},
      createGain: () => ({ gain: { value: 1 }, connect() {} }),
      createBuffer: (channels: number, length: number) => { const entry = { channels, length, planes: [] as number[][] }; made.push(entry); return { copyToChannel: (plane: Float32Array, channel: number) => { entry.planes[channel] = [...plane] } } },
      createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
      resume: async () => {}, close: async () => {}
    }
    const session = await openSpeakerSession({ rate: 48000, channels: 2, environment: { createContext: () => context as never, getUserMedia: async () => { throw new Error('no') } } })
    expect(session.info).toMatchObject({ rate: 48000, channels: 2 })
    // left 16384 / right -16384, then left 0 / right 8192, with the second frame cut after three bytes
    await session.write!(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x00, 0x00, 0x00]))
    await session.write!(new Uint8Array([0x20]))
    expect(made.map(({ channels, length }) => [channels, length])).toEqual([[2, 1], [2, 1]])
    expect(made[0]!.planes).toEqual([[0.5], [-0.5]])
    expect(made[1]!.planes).toEqual([[0], [0.25]])
    await session.close()
  })
})

describe('a camera as a session', () => {
  it('sends length-prefixed JPEG pictures and lets go of the camera', async () => {
    const stopped: string[] = []
    let shot = 0
    const environment = {
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'm', label: 'Mic' }, { kind: 'videoinput', deviceId: 'cam1', label: 'Front' }],
      getUserMedia: async () => ({ getVideoTracks: () => [{ addEventListener() {} }], getTracks: () => [{ stop: () => stopped.push('track') }] }) as never,
      play: async () => ({ video: {} as never, width: 640, height: 480, stop: () => stopped.push('video') }),
      jpeg: async () => new Uint8Array([0xff, 0xd8, ++shot])
    }
    const session = await openCameraSession({ environment, fps: 30 })
    expect(session.info).toMatchObject({ kind: 'camera', name: 'Front', width: 640, height: 480, format: 'jpeg-lp' })
    const frame = (await session.read!())!
    expect([...frame.subarray(0, 4)]).toEqual([3, 0, 0, 0])
    expect([...frame.subarray(4, 6)]).toEqual([0xff, 0xd8])
    expect([...frameOf(new Uint8Array([7]))]).toEqual([1, 0, 0, 0, 7])
    expect(await session.control!('list', [])).toEqual(['Front'])
    session.close()
    expect(stopped.sort()).toEqual(['track', 'video'])
    await expect(openCameraSession({ environment, index: 3 })).rejects.toMatchObject({ code: 'ENODEV' })
  })
})

describe('the spec of a device to offer', () => {
  it('takes every kind and refuses options a kind does not have', async () => {
    vi.stubGlobal('navigator', { getBattery: async () => new FakeBattery(), geolocation: { watchPosition: () => 1, clearWatch() {} } })
    expect((await openLocalDevice('battery')).info).toMatchObject({ kind: 'battery' })
    expect((await openLocalDevice('geo')).info).toMatchObject({ kind: 'geo' })
    await expect(openLocalDevice('battery,hz=5')).rejects.toThrow(/unknown option 'hz'/)
    await expect(openLocalDevice('sensor')).rejects.toThrow(/needs a sensor/)
    await expect(openLocalDevice('audio:sideways')).rejects.toThrow(/audio:in/)
    await expect(openLocalDevice('usb:0')).rejects.toThrow(/no WebUSB/)
    await expect(openLocalDevice('bluetooth:0')).rejects.toThrow(/cannot list Bluetooth/)
    await expect(openLocalDevice('serial')).rejects.toThrow(/needs a number/)
    await expect(openLocalDevice('serial:0,baud=fast')).rejects.toThrow(/baud is a number/)
    await expect(openLocalDevice('camera:0,flash=on')).rejects.toThrow(/unknown option 'flash'/)
  })
})
