import { ioctl } from '@zenfs/core'
import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { inputHub } from '#lib/evdev.ts'
import { padNodes, padState, parsePadId } from '#lib/gamepads.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const button = (pressed = false, value = pressed ? 1 : 0) => ({ pressed, value })

/** A pad as the browser shows it, which a test can press and move; it records what it was asked to vibrate */
function fakePad(index: number, id = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)') {
  const played: { type: string, params: Record<string, number> }[] = []
  return {
    id, index, mapping: 'standard', connected: true,
    buttons: Array.from({ length: 17 }, () => button()),
    axes: [0, 0, 0, 0],
    played,
    vibrationActuator: { playEffect: async (type: string, params: Record<string, number>) => { played.push({ type, params }) }, reset: async () => { played.push({ type: 'reset', params: {} }) } }
  }
}

const until = async (done: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) { if (await done()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('timed out')
}

// `_IOC(dir, 'E' or 'j', nr, size)`
const ioc = (dir: number, type: number, nr: number, size: number) => ((dir << 30) | (size << 16) | (type << 8) | nr) >>> 0
const E = 0x45, J = 0x6a, READ = 2, WRITE = 1
const bit = (bytes: Uint8Array, code: number) => !!(bytes[code >> 3]! & (1 << (code & 7)))
const ints = (bytes: Uint8Array) => Array.from({ length: bytes.length / 4 }, (_, i) => new DataView(bytes.buffer, bytes.byteOffset).getInt32(i * 4, true))

describe('the browser\'s pads, as a Linux gamepad', () => {
  it('names the controls as Linux does for a standard pad, and as a generic joystick for any other', () => {
    const pad = fakePad(0)
    pad.buttons[0] = button(true)
    pad.buttons[6] = button(true, 0.5)
    pad.buttons[15] = button(true)
    pad.axes = [-1, 0.5, 0, 1]
    const { keys, abs } = padState(pad)
    expect(keys.get(0x130)).toBe(1) // BTN_SOUTH
    expect(keys.get(0x138)).toBe(1) // BTN_TL2, the trigger as a button
    expect(keys.get(0x13c)).toBe(0) // BTN_MODE, button 16
    expect(keys.has(0x220)).toBe(false) // the d-pad is the hat, not buttons
    expect([abs.get(0x00), abs.get(0x01), abs.get(0x04)]).toEqual([-32767, 16384, 32767]) // ABS_X, ABS_Y, ABS_RY
    expect(abs.get(0x02)).toBe(128) // ABS_Z, the trigger as an axis
    expect([abs.get(0x10), abs.get(0x11)]).toEqual([1, 0]) // the hat: right
    const generic = padState({ ...fakePad(0), mapping: '', buttons: [button(true), button()], axes: [0.25, 0, 0] })
    expect([...generic.keys.keys()]).toEqual([0x120, 0x121]) // BTN_TRIGGER, BTN_THUMB
    expect([...generic.abs.keys()]).toEqual([0x00, 0x01, 0x02])
  })

  it('reads the vendor, product and name from Chrome\'s and Firefox\'s pad ids', () => {
    expect(parsePadId('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toEqual({ name: 'Wireless Controller', vendor: 0x054c, product: 0x09cc })
    expect(parsePadId('045e-028e-Microsoft X-Box 360 pad')).toEqual({ name: 'Microsoft X-Box 360 pad', vendor: 0x045e, product: 0x028e })
    expect(parsePadId('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toEqual({ name: 'Xbox 360 Controller', vendor: 0, product: 0 })
  })
})

describe('/dev/input/event<N> and /dev/input/js<N> for a pad', () => {
  let kernel: Kernel
  const slots: (ReturnType<typeof fakePad> | null)[] = [null, null, null, null]
  const connect = (pad: ReturnType<typeof fakePad>) => {
    pad.connected = true
    slots[pad.index] = pad
    globalThis.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }))
  }
  const disconnect = (pad: ReturnType<typeof fakePad>) => {
    pad.connected = false
    slots[pad.index] = null
    globalThis.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: pad }))
  }
  const fs = () => kernel.filesystem.fs
  const rdev = async (path: string) => { const value = BigInt((await fs().stat(path)).rdev); return [Number(value >> 20n), Number(value & 0xfffffn)] }
  const rows = async (path: string, width: number) => (await fs().readFile(path, 'utf-8')).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === width)

  beforeAll(async () => {
    Object.defineProperty(globalThis.navigator, 'getGamepads', { value: () => slots, configurable: true })
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_ALL })
    await kernel.boot()
  })

  const pad = fakePad(0)

  it('a pad that connects gets the first event number after the windows\', js0, and names under /dev/input/by-id', async () => {
    expect(await fs().exists('/dev/js0')).toBe(false)
    const before = Math.floor((await fs().stat('/dev/input')).mtimeMs / 1000)
    connect(pad)
    // the directory changed, in whole seconds, which is what a program that polls it (SDL without inotify) compares
    await until(async () => Math.floor((await fs().stat('/dev/input')).mtimeMs / 1000) > before)
    expect(await rdev('/dev/input/event34')).toEqual([13, 98])
    expect(await rdev('/dev/input/js0')).toEqual([13, 0])
    await until(async () => await fs().exists('/dev/input/by-id/usb-Wireless_Controller-joystick'))
    expect(await fs().readlink('/dev/input/by-id/usb-Wireless_Controller-event-joystick')).toBe('../event34')
    expect(await fs().readlink('/dev/input/by-id/usb-Wireless_Controller-joystick')).toBe('../js0')
  })

  it('answers what evtest and SDL ask an event device', async () => {
    const path = '/dev/input/event34'
    const name = await ioctl(path, ioc(READ, E, 0x06, 256)) as Uint8Array
    expect(new TextDecoder().decode(name).replace(/\0.*$/s, '')).toBe('Wireless Controller')
    const id = new DataView((await ioctl(path, ioc(READ, E, 0x02, 8)) as Uint8Array).buffer)
    expect([0, 1, 2, 3].map(i => id.getUint16(i * 2, true))).toEqual([0x03, 0x054c, 0x09cc, 0x0111])
    const types = await ioctl(path, ioc(READ, E, 0x20, 4)) as Uint8Array
    expect([0x00, 0x01, 0x03, 0x15].map(type => bit(types, type))).toEqual([true, true, true, true]) // SYN, KEY, ABS, FF
    const keys = await ioctl(path, ioc(READ, E, 0x21, 96)) as Uint8Array
    expect([0x130, 0x131, 0x133, 0x134, 0x13b, 0x13c].every(code => bit(keys, code))).toBe(true)
    expect(bit(keys, 0x110)).toBe(false) // not a mouse
    expect(ints(await ioctl(path, ioc(READ, E, 0x40, 24)) as Uint8Array)).toEqual([0, -32768, 32767, 16, 128, 0]) // ABS_X
    expect(ints(await ioctl(path, ioc(READ, E, 0x42, 24)) as Uint8Array)).toEqual([0, 0, 255, 0, 0, 0]) // ABS_Z
    expect(ints(await ioctl(path, ioc(READ, E, 0x84, 4)) as Uint8Array)).toEqual([16]) // EVIOCGEFFECTS
  })

  it('a program reading the event node gets what is pressed and moved after it opened it', async () => {
    const reading = kernel.shell.execute('dd if=/dev/input/event34 bs=24 count=5 2> /dev/null | od -An -tu1 -w24 -v > /tmp/pad.out')
    await until(() => inputHub.listening(98))
    await new Promise(resolve => setTimeout(resolve, 40))
    pad.buttons[0] = button(true)
    pad.buttons[15] = button(true)
    await new Promise(resolve => setTimeout(resolve, 40))
    pad.axes[0] = -1
    expect(await reading).toBe(0)
    const events = (await rows('/tmp/pad.out', 24)).map(row => [row[16]! | (row[17]! << 8), row[18]! | (row[19]! << 8), new DataView(Uint8Array.from(row.slice(20, 24)).buffer).getInt32(0, true)])
    // BTN_SOUTH down and the hat to the right in one report, then the stick to the left in the next
    expect(events).toEqual([[1, 0x130, 1], [3, 0x10, 1], [0, 0, 0], [3, 0x00, -32767], [0, 0, 0]])
    pad.buttons[0] = button()
    pad.buttons[15] = button()
    pad.axes[0] = 0
  }, 30000)

  it('/dev/input/js0 starts with the pad\'s state, then gives each change, in joydev\'s order', async () => {
    const js = '/dev/input/js0'
    expect(new Uint8Array(await ioctl(js, ioc(READ, J, 0x11, 1)) as Uint8Array)[0]).toBe(8) // JSIOCGAXES
    expect(new Uint8Array(await ioctl(js, ioc(READ, J, 0x12, 1)) as Uint8Array)[0]).toBe(13) // JSIOCGBUTTONS
    expect(new TextDecoder().decode(await ioctl(js, ioc(READ, J, 0x13, 64)) as Uint8Array).replace(/\0.*$/s, '')).toBe('Wireless Controller')
    const axmap = await ioctl(js, ioc(READ, J, 0x32, 0x40)) as Uint8Array
    expect([...axmap.subarray(0, 8)]).toEqual([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x10, 0x11])
    // 13 buttons and 8 axes of state, then a press of button 1 (BTN_EAST is joydev's button 1)
    const reading = kernel.shell.execute('dd if=/dev/input/js0 bs=8 count=22 2> /dev/null | od -An -tu1 -w8 -v > /tmp/js.out')
    await until(() => padNodes()[0]?.jsOpen === true)
    await new Promise(resolve => setTimeout(resolve, 40))
    pad.buttons[1] = button(true)
    expect(await reading).toBe(0)
    const events = await rows('/tmp/js.out', 8)
    expect(events).toHaveLength(22)
    expect(events.slice(0, 13).every(row => row[6] === 0x81)).toBe(true)
    expect(events.slice(13, 21).every(row => row[6] === 0x82)).toBe(true)
    // the init value of ABS_Z (released trigger, 0 of 0..255) is joydev's -32767
    expect(new DataView(Uint8Array.from(events[13 + 2]!.slice(4, 6)).buffer).getInt16(0, true)).toBe(-32767)
    expect(events[21]!.slice(4)).toEqual([1, 0, 0x01, 1])
    pad.buttons[1] = button()
  }, 30000)

  it('rumble: an effect uploaded with EVIOCSFF and played by writing EV_FF reaches the vibration motors', async () => {
    const path = '/dev/input/event34'
    const effect = new Uint8Array(44)
    const view = new DataView(effect.buffer)
    view.setUint16(0, 0x50, true) // FF_RUMBLE
    view.setInt16(2, -1, true) // a new effect
    view.setUint16(10, 300, true) // replay.length
    view.setUint16(16, 0xffff, true) // strong_magnitude
    view.setUint16(18, 0x8000, true) // weak_magnitude
    const uploaded = await ioctl(path, ioc(WRITE, E, 0x80, 44), effect) as Uint8Array
    const id = new DataView(uploaded.buffer, uploaded.byteOffset).getInt16(2, true)
    expect(id).toBe(0)
    const play = new Uint8Array(24)
    const event = new DataView(play.buffer)
    event.setUint16(16, 0x15, true) // EV_FF
    event.setUint16(18, id, true)
    event.setInt32(20, 1, true)
    const handle = await fs().open(path, 'r+')
    await handle.write(play)
    event.setInt32(20, 0, true)
    await handle.write(play)
    await handle.close()
    expect(pad.played[0]).toMatchObject({ type: 'dual-rumble', params: { duration: 300, strongMagnitude: 1 } })
    expect(pad.played[0]!.params['weakMagnitude']).toBeCloseTo(0.5, 2)
    expect(pad.played[1]!.type).toBe('reset')
    await ioctl(path, ioc(WRITE, E, 0x81, 4), id) // EVIOCRMFF
    await expect(ioctl(path, ioc(WRITE, E, 0x81, 4), id)).rejects.toThrow()
  })

  it('evtest lists the pad with the other input devices, describes it, and prints what it does until it is unplugged', async () => {
    const listed = await kernel.shell.execute('evtest < /dev/null > /tmp/evtest-list.out 2>&1')
    expect(listed).not.toBe(0)
    const list = await fs().readFile('/tmp/evtest-list.out', 'utf-8')
    expect(list).toContain('/dev/input/event0:\tecmaOS keyboard')
    expect(list).toContain('/dev/input/event34:\tWireless Controller')

    const watching = kernel.shell.execute('evtest /dev/input/event34 > /tmp/evtest.out 2>&1')
    const out = () => fs().readFile('/tmp/evtest.out', 'utf-8').catch(() => '')
    await until(async () => (await out()).includes('Testing ... (interrupt to exit)'))
    const described = await out()
    expect(described).toContain('Input device ID: bus 0x3 vendor 0x54c product 0x9cc version 0x111')
    expect(described).toContain('Input device name: "Wireless Controller"')
    expect(described).toMatch(/Event code 304 \(BTN_SOUTH\)/)
    expect(described).toMatch(/Event code 0 \(ABS_X\)\n\s+Value\s+0\n\s+Min\s+-32768\n\s+Max\s+32767\n\s+Fuzz\s+16\n\s+Flat\s+128/)
    expect(described).toMatch(/Event type 21 \(EV_FF\)\n\s+Event code 80 \(FF_RUMBLE\)/)
    pad.buttons[3] = button(true)
    await until(async () => /type 1 \(EV_KEY\), code 307 \(BTN_NORTH\), value 1/.test(await out()))
    expect(await out()).toMatch(/-------------- SYN_REPORT ------------/)
    pad.buttons[3] = button()
    disconnect(pad)
    expect(await watching).not.toBe(0)
    expect(await out()).toMatch(/No such device/)
    connect(pad)
  }, 60000)

  it('a pad that goes takes its nodes, a reader gets ENODEV, and the numbers come back for the next pad', async () => {
    const reading = kernel.shell.execute('dd if=/dev/input/event34 bs=24 count=1 > /dev/null 2> /tmp/gone.err')
    await until(() => inputHub.listening(98))
    disconnect(pad)
    expect(await reading).not.toBe(0)
    expect(await fs().readFile('/tmp/gone.err', 'utf-8')).toMatch(/No such device/)
    expect(await fs().exists('/dev/input/event34')).toBe(false)
    expect(await fs().exists('/dev/input/js0')).toBe(false)
    await until(async () => !await fs().exists('/dev/input/by-id/usb-Wireless_Controller-joystick'))
    const other = fakePad(1, '045e-028e-Microsoft X-Box 360 pad')
    connect(other)
    const same = fakePad(2, other.id)
    connect(same)
    expect(padNodes().map(({ event, js, name }) => [event, js, name])).toEqual([[34, 0, 'Microsoft X-Box 360 pad'], [35, 1, 'Microsoft X-Box 360 pad']])
    await until(async () => await fs().exists('/dev/input/by-id/usb-Microsoft_X-Box_360_pad-2-joystick'))
    expect(await fs().readlink('/dev/input/by-id/usb-Microsoft_X-Box_360_pad-2-event-joystick')).toBe('../event35')
  })
})
