import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDrivers, openUsbSession, usbOptionsFor } from '@ecmaos-devices/usb'

const ctx = {} as never

afterEach(() => { vi.unstubAllGlobals() })

describe('usb stream settings', () => {
  it('default to the first bulk or interrupt endpoints', () => {
    const device = { vendorId: 0x2341, productId: 0x43, productName: 'Uno' }
    expect(usbOptionsFor(undefined, device)).toEqual({ auto: true })
    expect(usbOptionsFor('not = = toml', device)).toEqual({ auto: true })
  })

  it('take top-level keys and a device table by hex id or product name', () => {
    const text = 'interface = 1\n[device."2341:0043"]\nin = 1\nout = 2\n[device.Other]\nin = 5\n'
    expect(usbOptionsFor(text, { vendorId: 0x2341, productId: 0x43 })).toEqual({ auto: true, interface: 1, in: 1, out: 2 })
    expect(usbOptionsFor(text, { vendorId: 1, productId: 2, productName: 'Other' })).toEqual({ auto: true, interface: 1, in: 5 })
    expect(usbOptionsFor('in = "x"\nout = -1', { vendorId: 1, productId: 2 })).toEqual({ auto: true })
  })
})

describe('usb device nodes', () => {
  it('have only the control node where WebUSB does not exist', async () => {
    vi.stubGlobal('navigator', {})
    expect((await getDrivers(ctx)).map(driver => driver.name)).toEqual(['usb'])
  })

  it('add usb<N> nodes on major 180 for each granted device', async () => {
    vi.stubGlobal('navigator', { usb: { getDevices: async () => [{}, {}] } })
    const drivers = await getDrivers(ctx)
    expect(drivers.map(driver => [driver.name, driver.major, driver.minor])).toEqual([['usb', 180, 0], ['usb0', 180, 1], ['usb1', 180, 2]])
  })
})

describe('usb session endpoint detection', () => {
  it('picks the first non-isochronous IN and OUT endpoints', async () => {
    const endpoints = [
      { endpointNumber: 3, direction: 'in', type: 'isochronous', packetSize: 8 },
      { endpointNumber: 2, direction: 'in', type: 'bulk', packetSize: 64 },
      { endpointNumber: 4, direction: 'out', type: 'interrupt', packetSize: 64 }
    ]
    const device = {
      vendorId: 1, productId: 2, opened: false,
      configuration: { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternate: { endpoints } }] },
      open: async () => { device.opened = true }, close: async () => { device.opened = false },
      claimInterface: async () => {}, releaseInterface: async () => {},
      transferIn: () => new Promise(() => {})
    }
    const session = await openUsbSession(device as never, { auto: true })
    expect(session.info).toMatchObject({ read: true, write: true, in: 2, out: 4 })
    await session.close()
  })
})
