import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDrivers as bluetoothDrivers } from '@ecmaos-devices/bluetooth'
import { getDrivers as serialDrivers } from '@ecmaos-devices/serial'
import { getDrivers as hidDrivers } from '@ecmaos-devices/hid'

import { fileMinorStore, StableMinors } from '@ecmaos-devices/session'
import type { MinorStore } from '@ecmaos-devices/session'

const memory = (initial?: string): MinorStore & { text?: string, writes: number } => {
  const store = { text: initial, writes: 0, async read() { return store.text }, async write(text: string) { store.text = text; store.writes++ } }
  return store
}

describe('stable minors', () => {
  it('number new devices from 1, in order, and save the table once', async () => {
    const store = memory()
    expect(await new StableMinors(store).assign(['a', 'b', 'c'])).toEqual([1, 2, 3])
    expect(JSON.parse(store.text!)).toEqual({ a: 1, b: 2, c: 3 })
    expect(store.writes).toBe(1)
  })

  it('keep a device\'s number across boots and when others go, and never reuse a number', async () => {
    const store = memory()
    await new StableMinors(store).assign(['a', 'b', 'c'])
    const reboot = new StableMinors(store)
    expect(await reboot.assign(['a', 'c'])).toEqual([1, 3])
    expect(await reboot.assign(['a', 'd', 'c'])).toEqual([1, 4, 3])
    expect(store.writes).toBe(2)
  })

  it('tell devices with one key apart by their order', async () => {
    const minors = new StableMinors(memory())
    expect(StableMinors.unique(['x', 'y', 'x', 'x'])).toEqual(['x', 'y', 'x#2', 'x#3'])
    expect(await minors.assign(['x', 'x'])).toEqual([1, 2])
  })

  it('finds the device a number stands for, or says it is gone', async () => {
    const minors = new StableMinors(memory())
    await minors.assign(['a', 'b'])
    expect(await minors.find(['b', 'a'], 1)).toBe(1)
    expect(await minors.find(['b'], 1)).toBe(-1)
  })

  it('starts again from a table it cannot read, and keeps numbering when it cannot save', async () => {
    expect(await new StableMinors(memory('not json')).assign(['a'])).toEqual([1])
    const failing: MinorStore = { read: async () => undefined, write: async () => { throw new Error('read-only') } }
    expect(await new StableMinors(failing).assign(['a', 'b'])).toEqual([1, 2])
  })

  it('ignores entries that are not numbers', async () => {
    expect(await new StableMinors(memory('{"a":"x","b":0,"c":2}')).assign(['a', 'c', 'd'])).toEqual([3, 2, 4])
  })
})

describe('the file store', () => {
  it('creates its directory, writes and reads back', async () => {
    const files = new Map<string, string>()
    const made: string[] = []
    const store = fileMinorStore({ promises: {
      readFile: async (path: string) => { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path)! },
      writeFile: async (path: string, data: string) => { files.set(path, data) },
      mkdir: async (path: string) => { made.push(path) }
    } }, '/var/lib/ecmaos/x.json')
    expect(await store.read()).toBeUndefined()
    await store.write('{"a":1}')
    expect(made).toEqual(['/var/lib/ecmaos/'.slice(0, -1)])
    expect(await store.read()).toBe('{"a":1}')
  })
})

describe('nodes of the other drivers', () => {
  const ctx = { log: { warn() {}, debug() {} }, events: { emit() {} } } as never
  afterEach(() => { vi.unstubAllGlobals() })
  const nodes = (drivers: Array<{ name: string, minor: number }>, control: string) => drivers.filter(driver => driver.name !== control).map(driver => `${driver.name}:${driver.minor}`)

  it('bluetooth devices keep their ble<N> when another is forgotten', async () => {
    vi.stubGlobal('navigator', { bluetooth: { getDevices: async () => [{ id: 'p' }, { id: 'q' }, { id: 'r' }] } })
    expect(nodes(await bluetoothDrivers(ctx), 'bluetooth')).toEqual(['ble0:1', 'ble1:2', 'ble2:3'])
    vi.stubGlobal('navigator', { bluetooth: { getDevices: async () => [{ id: 'p' }, { id: 'r' }] } })
    expect(nodes(await bluetoothDrivers(ctx), 'bluetooth')).toEqual(['ble0:1', 'ble2:3'])
  })

  it('serial ports keep their ttyS<N>', async () => {
    const port = (vendor: number) => ({ getInfo: () => ({ usbVendorId: vendor, usbProductId: 1 }) })
    const api = (ports: unknown[]) => ({ serial: { getPorts: async () => ports, addEventListener() {} } })
    vi.stubGlobal('navigator', api([port(10), port(11), port(12)]))
    expect(nodes(await serialDrivers(ctx), 'serial')).toEqual(['ttyS0:1', 'ttyS1:2', 'ttyS2:3'])
    vi.stubGlobal('navigator', api([port(10), port(12)]))
    expect(nodes(await serialDrivers(ctx), 'serial')).toEqual(['ttyS0:1', 'ttyS2:3'])
  })

  it('hid devices keep their hidraw<N>', async () => {
    const device = (productId: number) => ({ vendorId: 5, productId, productName: 'pad' })
    vi.stubGlobal('navigator', { hid: { getDevices: async () => [device(1), device(2), device(3)] } })
    expect(nodes(await hidDrivers(ctx), 'hid')).toEqual(['hidraw0:1', 'hidraw1:2', 'hidraw2:3'])
    vi.stubGlobal('navigator', { hid: { getDevices: async () => [device(1), device(3)] } })
    expect(nodes(await hidDrivers(ctx), 'hid')).toEqual(['hidraw0:1', 'hidraw2:3'])
  })
})
