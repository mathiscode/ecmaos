import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ioctl } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

class FakeHid extends EventTarget {
  opened = false
  constructor(readonly vendorId: number, readonly productId: number, readonly productName: string) { super() }
  collections: HIDCollectionInfo[] = []
  async open() { this.opened = true }
  async close() { this.opened = false }
}

const QUERYCAP = ((2 << 30) | (104 << 16) | (0x56 << 8) | 0) >>> 0
const GRAWNAME = ((2 << 30) | (256 << 16) | (0x48 << 8) | 4) >>> 0
const settle = () => new Promise(resolve => setTimeout(resolve, 50))
/** Waits for `condition`, which hotplug makes true a moment after the event */
const until = async (condition: () => Promise<boolean>) => {
  for (let tries = 0; tries < 100 && !await condition(); tries++) await settle()
}

describe('devices that come and go after boot', () => {
  let kernel: Kernel
  let hid: EventTarget & { devices: FakeHid[] }
  let media: EventTarget & { cameras: { kind: string, deviceId: string, label: string }[] }
  const exists = async (path: string) => await kernel.filesystem.fs.stat(path).then(() => true, () => false)

  beforeAll(async () => {
    hid = Object.assign(new EventTarget(), { devices: [] as FakeHid[], getDevices: async () => hid.devices })
    media = Object.assign(new EventTarget(), {
      cameras: [] as { kind: string, deviceId: string, label: string }[],
      enumerateDevices: async () => media.cameras,
      getUserMedia: async () => ({ getVideoTracks: () => [{ addEventListener() {}, getCapabilities: () => ({}) }], getTracks: () => [{ stop() {} }] })
    })
    Object.defineProperty(globalThis.navigator, 'hid', { value: hid, configurable: true })
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: media, configurable: true })
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
  })

  afterAll(() => {
    Object.defineProperty(globalThis.navigator, 'hid', { value: undefined, configurable: true })
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: undefined, configurable: true })
  })

  it('has no camera or hidraw node while there is no device', async () => {
    expect(await exists('/dev/video0')).toBe(false)
    expect(await exists('/dev/hidraw0')).toBe(false)
  })

  it('gives a camera a node when the browser says its devices changed, and takes it away again', async () => {
    media.cameras.push({ kind: 'videoinput', deviceId: 'a', label: 'Front Camera' })
    media.dispatchEvent(new Event('devicechange'))
    await until(() => exists('/dev/video0'))
    expect((await kernel.filesystem.fs.stat('/dev/video0')).isCharacterDevice()).toBe(true)
    const cap = await ioctl('/dev/video0', QUERYCAP) as Uint8Array
    expect(new TextDecoder().decode(cap.subarray(16, 48)).replace(/\0.*$/s, '')).toBe('Front Camera')

    media.cameras.push({ kind: 'videoinput', deviceId: 'b', label: 'Back Camera' })
    media.dispatchEvent(new Event('devicechange'))
    await until(() => exists('/dev/video1'))
    expect(await exists('/dev/video1')).toBe(true)

    media.cameras.length = 0
    media.dispatchEvent(new Event('devicechange'))
    await until(async () => !await exists('/dev/video0'))
    expect(await exists('/dev/video0')).toBe(false)
    expect(await exists('/dev/video1')).toBe(false)
  })

  it('gives a HID device a node on connect, and a program that has it open gets ENODEV when it goes', async () => {
    const pad = new FakeHid(0x054c, 0x09cc, 'Wireless Controller')
    hid.devices.push(pad)
    hid.dispatchEvent(new Event('connect'))
    await until(() => exists('/dev/hidraw0'))
    expect((await kernel.filesystem.fs.stat('/dev/hidraw0')).isCharacterDevice()).toBe(true)

    // a program waiting for a report, which none will come for
    const reading = kernel.shell.execute('dd if=/dev/hidraw0 bs=8 count=1 > /dev/null 2> /tmp/gone.err')
    await until(async () => pad.opened)
    hid.devices.length = 0
    hid.dispatchEvent(new Event('disconnect'))
    expect(await reading).not.toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/gone.err', 'utf8')).toMatch(/No such device/)
    await until(async () => !await exists('/dev/hidraw0'))
    expect(await exists('/dev/hidraw0')).toBe(false)
  })

  it('gives the same node back to the same device when it returns', async () => {
    const pad = new FakeHid(0x054c, 0x09cc, 'Wireless Controller')
    hid.devices.push(pad)
    hid.dispatchEvent(new Event('connect'))
    await until(() => exists('/dev/hidraw0'))
    expect(await exists('/dev/hidraw0')).toBe(true)
    const name = await ioctl('/dev/hidraw0', GRAWNAME) as Uint8Array
    expect(new TextDecoder().decode(name).replace(/\0.*$/s, '')).toBe('Wireless Controller')
  })
})
