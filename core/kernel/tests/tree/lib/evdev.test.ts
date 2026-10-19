import { describe, expect, it } from 'vitest'
import { EPOLLIN } from '@zenfs/linux'
import type { DeviceFile } from '@zenfs/linux'

import { BTN_LEFT, captureDom, decodeEvent, EV_KEY, EV_REL, EV_SYN, EvdevDevice, evdevIoctl, EventSize, InputHub, ioctlFields, KeyboardMinor, PointerMinor, REL_WHEEL, REL_X, Devices } from '#lib/evdev.ts'

const file = (minor: number) => ({ path: '/input/event', inode: {}, devt: { major: 13, minor } }) as unknown as DeviceFile
const readAll = (hub: InputHub, minor: number) => {
  const client = hub.client(minor)!
  const out = []
  while (client.events.length) out.push(decodeEvent(client.events.shift()!))
  return out
}
// _IOC(dir, 'E', nr, size)
const ioc = (direction: number, number: number, size: number) => ((direction << 30) | (size << 16) | (0x45 << 8) | number) >>> 0

describe('evdev', () => {
  it('a key press is a key event followed by a sync, 24 bytes each', () => {
    const hub = new InputHub()
    hub.open(KeyboardMinor)
    expect(hub.keyboard('KeyA', 1, 5_250)).toBe(true)
    const client = hub.client(KeyboardMinor)!
    expect(client.events.map(event => event.length)).toEqual([EventSize, EventSize])
    expect(readAll(hub, KeyboardMinor)).toEqual([
      { seconds: 5, microseconds: 250_000, type: EV_KEY, code: 30, value: 1 },
      { seconds: 5, microseconds: 250_000, type: EV_SYN, code: 0, value: 0 }
    ])
  })

  it('keeps the client for a second opener when the first closes, so a poller on its queue still wakes', () => {
    const hub = new InputHub()
    const first = hub.attach(KeyboardMinor)
    hub.attach(KeyboardMinor)
    let woken = 0
    first.queue.wait_with(() => { woken++ })
    hub.release(KeyboardMinor)
    expect(hub.client(KeyboardMinor)).toBe(first)
    hub.keyboard('KeyA', 1)
    expect(woken).toBe(1)
    hub.release(KeyboardMinor)
    expect(hub.client(KeyboardMinor)).toBeUndefined()
  })

  it('keeps nothing for a node nobody has open, and forgets a node when it is released', () => {
    const hub = new InputHub()
    hub.keyboard('KeyA', 1)
    expect(hub.client(KeyboardMinor)).toBeUndefined()
    hub.open(KeyboardMinor)
    hub.release(KeyboardMinor)
    expect(hub.listening(KeyboardMinor)).toBe(false)
  })

  it('ignores a key and a button it has no code for', () => {
    const hub = new InputHub()
    hub.open(KeyboardMinor)
    expect(hub.keyboard('Unidentified', 1)).toBe(false)
    expect(hub.button(9, true)).toBe(false)
    expect(hub.client(KeyboardMinor)!.events).toHaveLength(0)
  })

  it('pointer movement, buttons and wheel go to the pointer node, with the whole-pixel part of a move', () => {
    const hub = new InputHub()
    hub.open(PointerMinor)
    hub.move(3.9, -2)
    hub.button(0, true)
    hub.wheel(0, 1)
    hub.move(0.4, 0)
    expect(readAll(hub, PointerMinor).filter(event => event.type !== EV_SYN).map(event => [event.type, event.code, event.value])).toEqual([
      [EV_REL, REL_X, 3], [EV_REL, 1, -2], [EV_KEY, BTN_LEFT, 1], [EV_REL, REL_WHEEL, 1]
    ])
  })

  it('drops the oldest events past the limit', () => {
    const hub = new InputHub()
    hub.open(KeyboardMinor)
    for (let i = 0; i < 2000; i++) hub.keyboard('KeyA', i % 2 as 0 | 1)
    expect(hub.client(KeyboardMinor)!.events.length).toBe(1024)
  })

  it('tracks the keys that are down', () => {
    const hub = new InputHub()
    hub.keyboard('ShiftLeft', 1)
    hub.keyboard('KeyA', 1)
    hub.keyboard('KeyA', 0)
    expect([...hub.down]).toEqual([42])
  })

  describe('the node', () => {
    const setup = async () => {
      const [keyboard, pointer] = await EvdevDevice.getDrivers({} as never)
      return { keyboard: keyboard!, pointer: pointer! }
    }

    it('is /dev/input/event0 and event1 on major 13', async () => {
      const { keyboard, pointer } = await setup()
      expect([keyboard.name, keyboard.major, keyboard.minor]).toEqual(['input!event0', 13, 64])
      expect([pointer.name, pointer.major, pointer.minor]).toEqual(['input!event1', 13, 65])
    })

    it('reads whole events, refuses a buffer too small for one, and is readable for poll when it has some', async () => {
      const { keyboard } = await setup()
      const ops = keyboard.ops
      ops.open!(file(KeyboardMinor))
      expect(ops.poll!(file(KeyboardMinor)) & EPOLLIN).toBe(0)
      const { inputHub } = await import('#lib/evdev.ts')
      inputHub.keyboard('Enter', 1)
      expect(ops.poll!(file(KeyboardMinor)) & EPOLLIN).toBe(EPOLLIN)
      expect(() => ops.read!(file(KeyboardMinor), new Uint8Array(10), 0, 10)).toThrow()
      const buffer = new Uint8Array(100)
      expect(ops.read!(file(KeyboardMinor), buffer, 0, 100)).toBe(48)
      expect(decodeEvent(buffer.subarray(0, 24)).code).toBe(28)
      expect(ops.read!(file(KeyboardMinor), buffer, 0, 100)).toBe(0)
      ops.release!(file(KeyboardMinor))
    })

    it('answers the identifying ioctls', async () => {
      const { keyboard } = await setup()
      const handler = (request: number) => (keyboard.ops.ioctl as Record<number, (...args: unknown[]) => Uint8Array>)[request]!({}, file(KeyboardMinor))
      expect(new DataView(handler(ioc(2, 0x01, 4)).buffer).getInt32(0, true)).toBe(0x010001)
      expect(new TextDecoder().decode(handler(ioc(2, 0x06, 64)).subarray(0, 15))).toBe('ecmaOS keyboard')
      expect(() => handler(ioc(2, 0x77, 4))).toThrow()
      expect((keyboard.ops.ioctl as Record<number, unknown>)[0x5401]).toBeUndefined()
    })
  })

  it('EVIOCGBIT reports the event types and the keys of a device', () => {
    const hub = new InputHub()
    const [keyboard, pointer] = Devices
    const types = evdevIoctl(keyboard!, hub, ioc(2, 0x20, 4))!
    expect(types[0]! & (1 << EV_KEY)).toBeTruthy()
    expect(types[0]! & (1 << EV_REL)).toBeFalsy()
    const keys = evdevIoctl(keyboard!, hub, ioc(2, 0x20 + EV_KEY, 96))!
    expect(keys[30 >> 3]! & (1 << (30 & 7))).toBeTruthy()
    const buttons = evdevIoctl(pointer!, hub, ioc(2, 0x20 + EV_KEY, 96))!
    expect(buttons[BTN_LEFT >> 3]! & (1 << (BTN_LEFT & 7))).toBeTruthy()
    expect(ioctlFields(ioc(2, 0x06, 64))).toEqual({ direction: 2, type: 0x45, number: 6, size: 64 })
  })

  describe.skipIf(typeof document === 'undefined')('the page', () => {
    it('feeds an open node from key, mouse and wheel events, and only while it is open', () => {
      const hub = new InputHub()
      const stop = captureDom(document, hub)
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }))
      expect(hub.client(KeyboardMinor)).toBeUndefined()
      hub.open(KeyboardMinor)
      hub.open(PointerMinor)
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }))
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', repeat: true }))
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA' }))
      expect(readAll(hub, KeyboardMinor).filter(event => event.type === EV_KEY).map(event => event.value)).toEqual([1, 2, 0])
      document.dispatchEvent(new MouseEvent('mousedown', { button: 2 }))
      document.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
      expect(readAll(hub, PointerMinor).filter(event => event.type !== EV_SYN).map(event => [event.code, event.value])).toEqual([[0x111, 1], [REL_WHEEL, -1]])
      stop()
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' }))
      expect(hub.client(KeyboardMinor)!.events).toHaveLength(0)
    })
  })
})
