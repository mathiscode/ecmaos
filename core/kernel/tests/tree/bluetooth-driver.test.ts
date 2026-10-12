import { afterEach, describe, expect, it, vi } from 'vitest'

import { bluetoothOptionsFor, getDrivers, NORDIC_UART } from '@ecmaos-devices/bluetooth'

const ctx = {} as never

afterEach(() => { vi.unstubAllGlobals() })

describe('bluetooth stream settings', () => {
  it('default to the Nordic UART service', () => {
    expect(bluetoothOptionsFor(undefined, { id: 'x' })).toEqual(NORDIC_UART)
    expect(bluetoothOptionsFor('this is not = = toml', { id: 'x' })).toEqual(NORDIC_UART)
  })

  it('take top-level keys for every device and a device table for one, by name or id', () => {
    const text = 'chunk = 40\n[device."HM-10"]\nservice = "ffe0"\nnotify = "ffe1"\nwrite = "ffe1"\n[device.abc]\nchunk = 8\n'
    expect(bluetoothOptionsFor(text, { name: 'Other', id: 'zzz' })).toEqual({ ...NORDIC_UART, chunk: 40 })
    expect(bluetoothOptionsFor(text, { name: 'HM-10', id: 'zzz' })).toEqual({ service: 'ffe0', notify: 'ffe1', write: 'ffe1', chunk: 40 })
    expect(bluetoothOptionsFor(text, { name: 'Other', id: 'abc' })).toEqual({ ...NORDIC_UART, chunk: 8 })
  })

  it('ignore values of the wrong type', () => {
    expect(bluetoothOptionsFor('service = 5\nchunk = "big"', { id: 'x' })).toEqual(NORDIC_UART)
  })
})

describe('bluetooth device nodes', () => {
  it('register nothing where Web Bluetooth does not exist', async () => {
    vi.stubGlobal('navigator', {})
    expect(await getDrivers(ctx)).toEqual([])
  })

  it('register the control node and one node per paired device', async () => {
    vi.stubGlobal('navigator', { bluetooth: { getDevices: async () => [{ id: 'a' }, { id: 'b' }] } })
    const drivers = await getDrivers(ctx)
    expect(drivers.map(driver => [driver.name, driver.minor])).toEqual([['bluetooth', 0], ['ble0', 1], ['ble1', 2]])
  })

  it('still register the control node when getDevices is unavailable', async () => {
    vi.stubGlobal('navigator', { bluetooth: {} })
    expect((await getDrivers(ctx)).map(driver => driver.name)).toEqual(['bluetooth'])
  })
})
