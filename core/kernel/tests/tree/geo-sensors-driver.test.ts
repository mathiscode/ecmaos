import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDrivers as geoDrivers, openGeoSession } from '@ecmaos-devices/geo'
import { getDrivers as sensorDrivers, openSensorSession, SensorKinds } from '@ecmaos-devices/sensors'
import { firstReading } from '@ecmaos-devices/session'

const ctx = {} as never
const text = (chunk: Uint8Array | undefined) => new TextDecoder().decode(chunk)

afterEach(() => { vi.unstubAllGlobals() })

const position = { timestamp: 5, coords: { latitude: 1.5, longitude: -2.5, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null } }

function fakeGeolocation() {
  const state = { cleared: [] as number[], ok: undefined as undefined | ((p: typeof position) => void), fail: undefined as undefined | ((e: { code: number, message: string }) => void) }
  return {
    state,
    api: {
      watchPosition: (ok: never, fail: never) => { state.ok = ok; state.fail = fail; return 7 },
      clearWatch: (id: number) => { state.cleared.push(id) },
      getCurrentPosition: (ok: (p: typeof position) => void) => ok(position)
    }
  }
}

describe('geo device', () => {
  it('has no node where the browser has no geolocation', async () => {
    vi.stubGlobal('navigator', {})
    expect(await geoDrivers(ctx)).toEqual([])
  })

  it('is one node, and its session gives JSON lines and stops watching when closed', async () => {
    const { state, api } = fakeGeolocation()
    vi.stubGlobal('navigator', { geolocation: api })
    expect((await geoDrivers(ctx)).map(driver => driver.name)).toEqual(['geo'])
    const session = await openGeoSession(api)
    state.ok!(position)
    expect(JSON.parse(text(await session.read!()))).toMatchObject({ t: 5, latitude: 1.5, longitude: -2.5, accuracy: 10, altitude: null })
    await session.close()
    expect(state.cleared).toEqual([7])
  })

  it('maps a refused permission to EACCES and ends the stream', async () => {
    const { state, api } = fakeGeolocation()
    const session = await openGeoSession(api)
    state.fail!({ code: 1, message: 'denied' })
    expect(await session.read!()).toBeUndefined()
  })

  it('answers the position control with one fix', async () => {
    const { api } = fakeGeolocation()
    const session = await openGeoSession(api)
    expect(await session.control!('position', undefined as never)).toMatchObject({ latitude: 1.5 })
    await expect(session.control!('nope', undefined as never)).rejects.toMatchObject({ code: 'ENOSYS' })
    await session.close()
  })

  it('as a first reading gives one line and then the end, letting the device go', async () => {
    const { state, api } = fakeGeolocation()
    const session = firstReading(await openGeoSession(api))
    state.ok!(position)
    expect(text(await session.read!())).toContain('"latitude":1.5')
    expect(await session.read!()).toBeUndefined()
    expect(state.cleared).toEqual([7])
  })
})

class FakeSensor extends EventTarget {
  static started = 0
  static stopped = 0
  static last: FakeSensor | undefined
  activated = false
  hasReading = false
  timestamp = 9
  x = 1; y = 2; z = 3
  constructor(public options: { frequency: number }) { super(); FakeSensor.last = this }
  start() { FakeSensor.started++; this.activated = true }
  stop() { FakeSensor.stopped++; this.activated = false }
}

describe('sensors device', () => {
  it('has the control node, and a node for each sensor class that exists', async () => {
    vi.stubGlobal('Accelerometer', FakeSensor)
    vi.stubGlobal('AmbientLightSensor', FakeSensor)
    const drivers = await sensorDrivers(ctx)
    expect(drivers.map(driver => driver.name)).toEqual(['sensors', 'sensor-accelerometer', 'sensor-light'])
    const minors = drivers.map(driver => driver.minor)
    expect(new Set(minors).size).toBe(minors.length)
    expect(drivers.find(driver => driver.name === 'sensor-accelerometer')!.minor).toBe(Object.keys(SensorKinds).indexOf('accelerometer') + 1)
  })

  it('has only the control node with no sensor classes', async () => {
    expect((await sensorDrivers(ctx)).map(driver => driver.name)).toEqual(['sensors'])
  })

  it('gives a JSON line for each reading and stops the sensor when closed', async () => {
    FakeSensor.started = FakeSensor.stopped = 0
    const session = await openSensorSession('accelerometer', { scope: { Accelerometer: FakeSensor }, permissions: { query: async () => ({ state: 'granted' }) }, frequency: 500 })
    expect(session.info).toMatchObject({ sensor: 'accelerometer', frequency: 60, fields: ['x', 'y', 'z'] })
    expect(FakeSensor.started).toBe(1)
    const reading = session.read!()
    FakeSensor.last!.dispatchEvent(new Event('reading'))
    expect(JSON.parse(text(await reading))).toEqual({ t: 9, x: 1, y: 2, z: 3 })
    const ended = session.read!()
    await session.close()
    expect(FakeSensor.stopped).toBe(1)
    expect(await ended).toBeUndefined()
  })

  it('refuses an unknown sensor, a missing class and a permission that is not granted', async () => {
    await expect(openSensorSession('nope')).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(openSensorSession('gyroscope', { scope: {}, permissions: undefined })).rejects.toMatchObject({ code: 'ENODEV' })
    await expect(openSensorSession('gyroscope', { scope: { Gyroscope: FakeSensor }, permissions: { query: async () => ({ state: 'denied' }) } })).rejects.toMatchObject({ code: 'EACCES' })
  })
})
