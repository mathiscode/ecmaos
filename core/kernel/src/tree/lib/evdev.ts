/**
 * Linux input devices: `/dev/input/event0` (keyboard) and `/dev/input/event1` (pointer), a window's own (see
 * `registerWindowInput`) and the gamepads' (see `gamepads.ts`). What the user does on the screen
 * is fed to the `InputHub`, which turns it into `struct input_event` records (24 bytes: seconds, microseconds, type, code,
 * value) for every node that is open. Like a real evdev client, a node only sees what happens after it was opened, and what
 * nobody reads is dropped from the oldest end instead of growing without bound.
 */

import { Class, Device, EPOLLIN, EPOLLOUT, syscalls, thread_of, WaitQueue } from '@zenfs/linux'
import type { DeviceFile, FileOperations, Process } from '@zenfs/linux'
import { ioctl as ioctlAsync, ioctlSync } from '@zenfs/core/vfs/ioctl'
import { withErrno } from 'kerium'
import { registerMinor } from './dynamic-minors.ts'
import { destroyGlContextsOf, setGlCaller } from './gl.ts'
import type { KernelCharDevice, KernelDevice, WindowInput } from '@ecmaos/types'

export const EV_SYN = 0, EV_KEY = 1, EV_REL = 2, EV_ABS = 3, EV_MSC = 4, EV_FF = 0x15
export const SYN_REPORT = 0
export const ABS_X = 0, ABS_Y = 1
export const REL_X = 0, REL_Y = 1, REL_HWHEEL = 6, REL_WHEEL = 8
export const BTN_LEFT = 0x110, BTN_RIGHT = 0x111, BTN_MIDDLE = 0x112, BTN_SIDE = 0x113, BTN_EXTRA = 0x114
export const EventSize = 24
export const InputMajor = 13
export const KeyboardMinor = 64
export const PointerMinor = 65

/** `KeyboardEvent.code` to Linux `KEY_*` */
export const KeyCodes: Readonly<Record<string, number>> = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23,
  KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29, KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33,
  KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58, F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66,
  F9: 67, F10: 68, NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75,
  Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  IntlBackslash: 86, F11: 87, F12: 88, IntlRo: 89, NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99,
  AltRight: 100, Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108,
  PageDown: 109, Insert: 110, Delete: 111, AudioVolumeMute: 113, AudioVolumeDown: 114, AudioVolumeUp: 115, Pause: 119,
  NumpadComma: 121, MetaLeft: 125, MetaRight: 126, ContextMenu: 127, F13: 183, F14: 184, F15: 185, F16: 186, F17: 187,
  F18: 188, F19: 189, F20: 190, F21: 191, F22: 192, F23: 193, F24: 194
}

/** `MouseEvent.button` to Linux `BTN_*` */
export const MouseButtons: Readonly<Record<number, number>> = { 0: BTN_LEFT, 1: BTN_MIDDLE, 2: BTN_RIGHT, 3: BTN_SIDE, 4: BTN_EXTRA }

export interface InputEvent {
  seconds: number
  microseconds: number
  type: number
  code: number
  value: number
}

export function encodeEvent(event: InputEvent): Uint8Array {
  const bytes = new Uint8Array(EventSize)
  const view = new DataView(bytes.buffer)
  view.setBigUint64(0, BigInt(event.seconds), true)
  view.setBigUint64(8, BigInt(event.microseconds), true)
  view.setUint16(16, event.type, true)
  view.setUint16(18, event.code, true)
  view.setInt32(20, event.value, true)
  return bytes
}

export function decodeEvent(bytes: Uint8Array): InputEvent {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    seconds: Number(view.getBigUint64(0, true)),
    microseconds: Number(view.getBigUint64(8, true)),
    type: view.getUint16(16, true),
    code: view.getUint16(18, true),
    value: view.getInt32(20, true)
  }
}

/** An absolute axis as `EVIOCGABS` describes it (`struct input_absinfo`) */
export interface AbsInfo {
  min: number
  max: number
  fuzz?: number
  flat?: number
  resolution?: number
}

/** One input device: what it is called, which event types it has, and the codes of each */
export interface DeviceSpec {
  name: string
  minor: number
  /** Bits of `EV_*` the device reports */
  types: number[]
  /** Codes of each type the device reports */
  codes: Record<number, number[]>
  /** `input_id`: bus (0x06 is virtual), vendor, product, version */
  id: [number, number, number, number]
  /** Each absolute axis (`EVIOCGABS`): its range, or just its largest value with 0 the smallest */
  abs?: Record<number, number | AbsInfo>
  /** Where an absolute axis is now; 0 when not given */
  value?(code: number): number
  /** The keys or buttons that are down now (`EVIOCGKEY`); the keyboard's come from the hub */
  down?(): number[]
  /** Force feedback (`EV_FF`): how many effects it holds at once, and what it does with them */
  ff?: {
    effects: number
    /** `EVIOCSFF`: the program's `struct ff_effect`; gives it back with the effect's id filled in */
    upload(effect: Uint8Array): Uint8Array
    /** `EVIOCRMFF` */
    erase(id: number): void
    /** An `EV_FF` event written to the node: an effect played (`value` times) or stopped (0), or `FF_GAIN` */
    play(code: number, value: number): void
  }
  /** The device is gone (unplugged): reads fail with `ENODEV` */
  gone?: boolean
}

const keyboardCodes = [...new Set(Object.values(KeyCodes))].sort((a, b) => a - b)

export const Devices: readonly DeviceSpec[] = [
  { name: 'ecmaOS keyboard', minor: KeyboardMinor, types: [EV_SYN, EV_KEY, EV_MSC], codes: { [EV_SYN]: [SYN_REPORT], [EV_KEY]: keyboardCodes, [EV_MSC]: [] }, id: [0x06, 0x0ec3, 0x0001, 1] },
  { name: 'ecmaOS pointer', minor: PointerMinor, types: [EV_SYN, EV_KEY, EV_REL], codes: { [EV_SYN]: [SYN_REPORT], [EV_KEY]: Object.values(MouseButtons), [EV_REL]: [REL_X, REL_Y, REL_HWHEEL, REL_WHEEL] }, id: [0x06, 0x0ec3, 0x0002, 1] }
]

/**
 * A pixel window's own input device, `/dev/input/event<2+N>` for framebuffer N (minor 66+N): the pointer as absolute
 * position in the window's pixels (`ABS_X`, `ABS_Y`), buttons, wheel and keys, only while the window has them. Two
 * private `EV_MSC` codes mark focus: `MSC_POINTER_ENTER` (1 when the pointer enters the window, 0 when it leaves) and
 * `MSC_KEYBOARD_FOCUS` (1 and 0 for gaining and losing the keyboard).
 */
export const WindowInputMinor = 66
export const MSC_POINTER_ENTER = 0x100, MSC_KEYBOARD_FOCUS = 0x101
/** The browser's clipboard text arrived (fetch it with `FBIO_GETPASTE`) and something was dropped on the window (`FBIO_GETDROP`) */
export const MSC_PASTE = 0x102, MSC_DROP = 0x103
/** The devices made at runtime (windows, gamepads), by minor */
const specs = new Map<number, DeviceSpec>()

const windowDeviceSpec = (index: number, width: number, height: number): DeviceSpec => ({
  name: `ecmaOS window ${index}`,
  minor: WindowInputMinor + index,
  types: [EV_SYN, EV_KEY, EV_REL, EV_ABS, EV_MSC],
  codes: {
    [EV_SYN]: [SYN_REPORT],
    [EV_KEY]: [...keyboardCodes, ...Object.values(MouseButtons)].sort((a, b) => a - b),
    [EV_REL]: [REL_HWHEEL, REL_WHEEL],
    [EV_ABS]: [ABS_X, ABS_Y],
    [EV_MSC]: [MSC_POINTER_ENTER, MSC_KEYBOARD_FOCUS, MSC_PASTE, MSC_DROP]
  },
  id: [0x06, 0x0ec3, 0x0003, 1],
  abs: { [ABS_X]: Math.max(width - 1, 0), [ABS_Y]: Math.max(height - 1, 0) }
})

/** The most events a node keeps for a reader that is slow; the oldest go first */
const QueueLimit = 1024

interface Client {
  events: Uint8Array[]
  queue: WaitQueue
  /** How many open files share this client; a poller sleeps on its queue, so it lives until the last one closes */
  users: number
}

/**
 * Where input enters the machine. The display layer calls `keyboard` and `pointer` with what the user did; every open event
 * node gets the events of its device.
 */
export class InputHub {
  private readonly clients = new Map<number, Client>()
  private readonly keys = new Set<number>()
  private readonly buttons = new Set<number>()

  /** Whether a node of `minor` is open, so a source can skip work when nobody listens */
  listening(minor?: number): boolean {
    return minor === undefined ? this.clients.size > 0 : this.clients.has(minor)
  }

  open(minor: number): Client {
    let client = this.clients.get(minor)
    if (!client) this.clients.set(minor, client = { events: [], queue: new WaitQueue(), users: 0 })
    return client
  }

  /** A file opened the node: it counts as a user of the client, which `open` alone (a poll or read that got there first) does not */
  attach(minor: number): Client {
    const client = this.open(minor)
    client.users++
    return client
  }

  release(minor: number) {
    const client = this.clients.get(minor)
    if (!client) return
    if (--client.users > 0) return
    this.clients.delete(minor)
    client.queue.wake_up()
  }

  /** The node is gone whoever still has it open (its window closed) */
  drop(minor: number) {
    const client = this.clients.get(minor)
    this.clients.delete(minor)
    client?.queue.wake_up()
  }

  client(minor: number): Client | undefined {
    return this.clients.get(minor)
  }

  /** Keys that are down now, as `EVIOCGKEY` reports them */
  get down(): ReadonlySet<number> { return this.keys }

  private emit(minor: number, events: [type: number, code: number, value: number][], now = Date.now()) {
    const client = this.clients.get(minor)
    if (!client) return
    const seconds = Math.floor(now / 1000)
    const microseconds = (now % 1000) * 1000
    for (const [type, code, value] of [...events, [EV_SYN, SYN_REPORT, 0] as [number, number, number]]) {
      client.events.push(encodeEvent({ seconds, microseconds, type, code, value }))
    }
    while (client.events.length > QueueLimit) client.events.shift()
    client.queue.wake_up()
  }

  /** Events of a device made at runtime (a gamepad), with the `SYN_REPORT` that ends them */
  report(minor: number, events: [type: number, code: number, value: number][], now?: number) {
    if (events.length) this.emit(minor, events, now)
  }

  /** What happened inside a pixel window, as the events of its own device */
  window(minor: number, input: WindowInput, now?: number) {
    switch (input.k) {
      case 'key': {
        const key = KeyCodes[input.code]
        if (key !== undefined) this.emit(minor, [[EV_KEY, key, input.down ? (input.repeat ? 2 : 1) : 0]], now)
        return
      }
      case 'pointer': this.emit(minor, [[EV_ABS, ABS_X, Math.round(input.x)], [EV_ABS, ABS_Y, Math.round(input.y)]], now); return
      case 'button': {
        const code = MouseButtons[input.button]
        if (code !== undefined) this.emit(minor, [[EV_KEY, code, input.down ? 1 : 0]], now)
        return
      }
      case 'wheel': {
        const events: [number, number, number][] = []
        if (Math.trunc(input.dy)) events.push([EV_REL, REL_WHEEL, Math.trunc(input.dy)])
        if (Math.trunc(input.dx)) events.push([EV_REL, REL_HWHEEL, Math.trunc(input.dx)])
        if (events.length) this.emit(minor, events, now)
        return
      }
      case 'size': return
      case 'paste': this.emit(minor, [[EV_MSC, MSC_PASTE, 1]], now); return
      case 'drop':
        this.emit(minor, [[EV_ABS, ABS_X, Math.round(input.x)], [EV_ABS, ABS_Y, Math.round(input.y)]], now)
        this.emit(minor, [[EV_MSC, MSC_DROP, 1]], now)
        return
      case 'enter': case 'leave': this.emit(minor, [[EV_MSC, MSC_POINTER_ENTER, input.k === 'enter' ? 1 : 0]], now); return
      case 'focus': case 'blur': this.emit(minor, [[EV_MSC, MSC_KEYBOARD_FOCUS, input.k === 'focus' ? 1 : 0]], now)
    }
  }

  /** A key went down (`value` 1), up (0) or repeated (2). Returns whether the key has a Linux code. */
  keyboard(code: string, value: 0 | 1 | 2, now?: number): boolean {
    const key = KeyCodes[code]
    if (key === undefined) return false
    if (value === 0) this.keys.delete(key)
    else this.keys.add(key)
    this.emit(KeyboardMinor, [[EV_KEY, key, value]], now)
    return true
  }

  /** Pointer movement in pixels, relative to where it was */
  move(dx: number, dy: number, now?: number) {
    const events: [number, number, number][] = []
    if (Math.trunc(dx)) events.push([EV_REL, REL_X, Math.trunc(dx)])
    if (Math.trunc(dy)) events.push([EV_REL, REL_Y, Math.trunc(dy)])
    if (events.length) this.emit(PointerMinor, events, now)
  }

  /** A pointer button (`MouseEvent.button`) went down or up. Returns whether the button has a Linux code. */
  button(button: number, down: boolean, now?: number): boolean {
    const code = MouseButtons[button]
    if (code === undefined) return false
    if (down) this.buttons.add(code)
    else this.buttons.delete(code)
    this.emit(PointerMinor, [[EV_KEY, code, down ? 1 : 0]], now)
    return true
  }

  /** The wheel, in notches (positive is up and to the right, as on Linux) */
  wheel(dx: number, dy: number, now?: number) {
    const events: [number, number, number][] = []
    if (Math.trunc(dy)) events.push([EV_REL, REL_WHEEL, Math.trunc(dy)])
    if (Math.trunc(dx)) events.push([EV_REL, REL_HWHEEL, Math.trunc(dx)])
    if (events.length) this.emit(PointerMinor, events, now)
  }
}

export const inputHub = new InputHub()

// - the page ------------------------------------------------------------------------------------------

/**
 * Feeds the hub from a page's keyboard and mouse. Nothing is prevented or stopped, so the page works as it did; a source with
 * no node open does nothing. Returns the function that removes the listeners.
 */
export function captureDom(target: Document, hub: InputHub = inputHub): () => void {
  const key = (value: 0 | 1) => (event: Event) => {
    const { code, repeat } = event as KeyboardEvent
    if (hub.listening(KeyboardMinor)) hub.keyboard(code, value === 1 && repeat ? 2 : value)
  }
  const move = (event: Event) => {
    const { movementX, movementY } = event as MouseEvent
    if (hub.listening(PointerMinor)) hub.move(movementX || 0, movementY || 0)
  }
  const button = (down: boolean) => (event: Event) => { if (hub.listening(PointerMinor)) hub.button((event as MouseEvent).button, down) }
  const wheel = (event: Event) => {
    const { deltaX, deltaY } = event as WheelEvent
    if (hub.listening(PointerMinor)) hub.wheel(Math.sign(deltaX), -Math.sign(deltaY))
  }
  const listeners: [string, (event: Event) => void][] = [
    ['keydown', key(1)], ['keyup', key(0)], ['mousemove', move], ['mousedown', button(true)], ['mouseup', button(false)], ['wheel', wheel]
  ]
  for (const [name, listener] of listeners) target.addEventListener(name, listener, { capture: true, passive: true })
  return () => { for (const [name, listener] of listeners) target.removeEventListener(name, listener, { capture: true }) }
}

// - ioctl ---------------------------------------------------------------------------------------------

const IOC_READ = 2, IOC_WRITE = 1
const EvdevType = 0x45 // 'E'
/** The type of the framebuffer requests (`FBIO*`), which answer with bytes in the same way */
const FbType = 0x46 // 'F'
const GlType = 0x47 // 'G': the GL devices (see gl.ts)
const RtcType = 0x70 // 'p': the real-time clock (see rtc.ts)
const JoystickType = 0x6a // 'j': the joystick API's nodes (see gamepads.ts)
const HidType = 0x48 // 'H': hidraw (see devices/hid), whose reports come from the browser and are waited for
const VideoType = 0x56 // 'V': video4linux (see devices/camera), whose pictures come from the browser

export interface Ioctl { direction: number, type: number, number: number, size: number }

/** Splits a request number into the fields Linux's `_IOC` packs into it */
export function ioctlFields(request: number): Ioctl {
  return { number: request & 0xff, type: (request >>> 8) & 0xff, size: (request >>> 16) & 0x3fff, direction: (request >>> 30) & 3 }
}

const bits = (codes: number[], size: number) => {
  const bytes = new Uint8Array(size)
  for (const code of codes) if (code >> 3 < size) bytes[code >> 3]! |= 1 << (code & 7)
  return bytes
}

/**
 * What an `EVIOC*` request reads back, as the bytes the program's buffer takes (at most `size`); `undefined` for one that
 * is not understood.
 */
export function evdevIoctl(spec: DeviceSpec, hub: InputHub, request: number, arg?: unknown): Uint8Array | undefined {
  const { type, number, size, direction } = ioctlFields(request)
  if (type !== EvdevType) return undefined
  if (number === 0x01 && direction === IOC_READ) { // EVIOCGVERSION
    const out = new Uint8Array(4)
    new DataView(out.buffer).setInt32(0, 0x010001, true)
    return out
  }
  if (number === 0x02 && direction === IOC_READ) { // EVIOCGID: struct input_id
    const out = new Uint8Array(8)
    const view = new DataView(out.buffer)
    spec.id.forEach((value, index) => view.setUint16(index * 2, value, true))
    return out
  }
  if (number === 0x06 && direction === IOC_READ) { // EVIOCGNAME(len)
    const name = new TextEncoder().encode(spec.name)
    const out = new Uint8Array(Math.min(size, name.length + 1))
    out.set(name.subarray(0, Math.max(0, out.length - 1)))
    return out
  }
  if (number === 0x07 || number === 0x08) return new Uint8Array(Math.min(size, 1)) // EVIOCGPHYS, EVIOCGUNIQ: empty strings
  // EVIOCGPROP (no properties: not a touchpad, not an accelerometer), EVIOCGLED, EVIOCGSND, EVIOCGSW: none set
  if ((number === 0x09 || number === 0x19 || number === 0x1a || number === 0x1b) && direction === IOC_READ) return new Uint8Array(size)
  if (number === 0x18 && direction === IOC_READ) { // EVIOCGKEY(len): the keys that are down
    return bits(spec.minor === KeyboardMinor ? [...hub.down] : spec.down?.() ?? [], size)
  }
  if (number >= 0x40 && number < 0x80 && direction === IOC_READ && spec.abs) { // EVIOCGABS(abs): struct input_absinfo
    const code = number - 0x40
    const given = spec.abs[code]
    if (given === undefined) return undefined
    const info = typeof given === 'number' ? { min: 0, max: given } : given
    const out = new Uint8Array(24)
    const view = new DataView(out.buffer)
    // value, minimum, maximum, fuzz, flat, resolution
    ;[spec.value?.(code) ?? 0, info.min, info.max, info.fuzz ?? 0, info.flat ?? 0, info.resolution ?? 0].forEach((value, index) => view.setInt32(index * 4, value, true))
    return out.subarray(0, Math.min(size, 24))
  }
  if (number >= 0x20 && number < 0x40 && direction === IOC_READ) { // EVIOCGBIT(ev, len)
    const ev = number - 0x20
    if (ev === 0) return bits(spec.types, size)
    return bits(spec.codes[ev] ?? [], size)
  }
  if (number === 0x90 && direction === IOC_WRITE) return new Uint8Array(0) // EVIOCGRAB: accepted; one reader at a time anyway
  if (spec.ff) {
    if (number === 0x84 && direction === IOC_READ) { // EVIOCGEFFECTS: how many effects can be held
      const out = new Uint8Array(4)
      new DataView(out.buffer).setInt32(0, spec.ff.effects, true)
      return out
    }
    if (number === 0x80 && direction === IOC_WRITE) { // EVIOCSFF(struct ff_effect)
      if (!(arg instanceof Uint8Array) || arg.length < 20) throw withErrno('EINVAL')
      return spec.ff.upload(arg)
    }
    if (number === 0x81 && direction === IOC_WRITE) { // EVIOCRMFF(id): the id itself, not a pointer to it
      spec.ff.erase(typeof arg === 'number' ? arg : -1)
      return new Uint8Array(0)
    }
  }
  return undefined
}

// - node ----------------------------------------------------------------------------------------------

export function nodeOperations(hub: InputHub = inputHub): FileOperations {
  const spec = (file: DeviceFile) => Devices.find(device => device.minor === file.devt.minor) ?? specs.get(file.devt.minor)
  return {
    open: file => { hub.attach(file.devt.minor) },
    release: file => { hub.release(file.devt.minor) },
    read: (file, buffer, start, end) => {
      if (spec(file)?.gone) throw withErrno('ENODEV')
      const client = hub.client(file.devt.minor) ?? hub.open(file.devt.minor)
      if (end - start < EventSize) throw withErrno('EINVAL')
      let done = 0
      while (client.events.length && done + EventSize <= end - start) {
        buffer.set(client.events.shift()!, start + done)
        done += EventSize
      }
      return done
    },
    // what a program writes is events for the device: only force feedback (`EV_FF`) means anything here
    // a character device has no position: the file system passes one as `offset`, the write syscall 0
    write: (file, data) => {
      const device = spec(file)
      if (device?.gone) throw withErrno('ENODEV')
      if (!device?.ff || data.length < EventSize) throw withErrno('EINVAL')
      let done = 0
      for (; done + EventSize <= data.length; done += EventSize) {
        const event = decodeEvent(data.subarray(done, done + EventSize))
        if (event.type === EV_FF) device.ff.play(event.code, event.value)
      }
      return done
    },
    // a gone device is readable, so a reader waiting on it wakes to the error
    poll: file => (hub.client(file.devt.minor)?.events.length || spec(file)?.gone ? EPOLLIN : 0) | EPOLLOUT,
    poll_wait: file => (hub.client(file.devt.minor) ?? hub.open(file.devt.minor)).queue,
    ioctl: new Proxy({}, {
      get: (_target, key) => {
        const request = Number(key)
        if (!Number.isInteger(request) || ioctlFields(request).type !== EvdevType) return undefined
        return (_context: unknown, file: DeviceFile, arg?: unknown) => {
          const device = spec(file)
          if (device?.gone) throw withErrno('ENODEV')
          const out = device && evdevIoctl(device, hub, request, arg)
          if (!out) throw withErrno('ENOTTY')
          return out
        }
      },
      has: (_target, key) => Number.isInteger(Number(key)) && ioctlFields(Number(key)).type === EvdevType
    }) as FileOperations['ioctl']
  }
}

/**
 * A program's `ioctl` can only get a number back; a structure is left in the return region of its thread. `EVIOC*` requests
 * (and `FBIO*`, `JSIOC*`, the GL devices' and `RTC_*`) answer with bytes, so the syscall is wrapped to put them there and
 * give their length, as the upstream `ioctl` does for `TIOCGWINSZ` and `TCGETS`. Idempotent.
 */
const glWatched = new Set<number>()
let wrapped = false
export function installEvdevIoctl() {
  if (wrapped) return
  wrapped = true
  const original = syscalls.get('ioctl' as never) as ((proc: Process, ...args: unknown[]) => unknown) | undefined
  if (!original) return
  syscalls.set('ioctl' as never, ((proc: Process, fd: number, request: number, arg: unknown) => {
    const type = ioctlFields(request >>> 0).type
    if (type !== EvdevType && type !== FbType && type !== GlType && type !== RtcType && type !== JoystickType && type !== HidType && type !== VideoType) return original(proc, fd, request, arg)
    if (type === GlType) {
      setGlCaller(proc.pid)
      if (!glWatched.has(proc.pid)) {
        glWatched.add(proc.pid)
        void proc.exited.then(() => { glWatched.delete(proc.pid); destroyGlContextsOf(proc.pid) })
      }
    }
    // a feature report is asked of the device and comes back later: the syscall answers when it has
    if (type === HidType || type === VideoType) {
      return (ioctlAsync as unknown as (this: unknown, ...args: unknown[]) => Promise<unknown>).call(proc.context, fd, request, arg)
        .then(value => value instanceof Uint8Array ? thread_of(proc).put(value) : typeof value === 'number' ? value : 0)
    }
    let value: unknown
    try { value = (ioctlSync as unknown as (this: unknown, ...args: unknown[]) => unknown).call(proc.context, fd, request, arg) } finally { setGlCaller(undefined) }
    return value instanceof Uint8Array ? thread_of(proc).put(value) : typeof value === 'number' ? value : 0
  }) as never)
}

export const input_class = new Class('input')

/**
 * Makes the node of an input device made at runtime, `/dev/input/<name>` on the input major with `spec.minor`, answered by
 * the event node operations. Returns the function that removes it; whoever still has it open is woken.
 */
export function addInputDevice(name: string, spec: DeviceSpec, ops: FileOperations = nodeOperations(inputHub)): () => void {
  specs.set(spec.minor, spec)
  let device: Device | undefined
  try {
    device = new Device({ name: `input!${name}`, class: input_class, dev_t: { major: InputMajor, minor: spec.minor } })
    device.register()
  } catch { device = undefined /* no input major here (a kernel without devices) */ }
  registerMinor(InputMajor, spec.minor, ops)
  return () => {
    // a file still open on it gets ENODEV, as on Linux, until another device takes the minor
    registerMinor(InputMajor, spec.minor, goneOperations)
    specs.delete(spec.minor)
    inputHub.drop(spec.minor)
    try { device?.unregister() } catch { /* gone */ }
  }
}

/** What a file open on an input device that has gone gets: readable, so a waiting reader wakes, and `ENODEV` from anything else */
const goneQueue = new WaitQueue()
export const goneOperations: FileOperations = {
  read: () => { throw withErrno('ENODEV') },
  write: () => { throw withErrno('ENODEV') },
  poll: () => EPOLLIN | EPOLLOUT,
  poll_wait: () => goneQueue,
  ioctl: new Proxy({}, {
    get: (_target, key) => inputRequest(key) ? () => { throw withErrno('ENODEV') } : undefined,
    has: (_target, key) => inputRequest(key)
  }) as FileOperations['ioctl']
}

/** An event device's request (`EVIOC*`) or a joystick's (`JSIOC*`) */
const inputRequest = (key: PropertyKey) => {
  const request = Number(key)
  if (!Number.isInteger(request)) return false
  const type = ioctlFields(request >>> 0).type
  return type === EvdevType || type === JoystickType
}

/**
 * Makes the input device of pixel window `index` (`/dev/input/event<2+index>`). Returns the minor, the hub's events for it
 * and the function that removes the node.
 */
export function registerWindowInput(index: number, width: number, height: number): { minor: number, remove: () => void, resize: (width: number, height: number) => void } {
  const spec = windowDeviceSpec(index, width, height)
  const remove = addInputDevice(`event${2 + index}`, spec)
  const resize = (w: number, h: number) => { spec.abs = { [ABS_X]: Math.max(w - 1, 0), [ABS_Y]: Math.max(h - 1, 0) } }
  return { minor: spec.minor, resize, remove }
}

export const EvdevDevice: KernelDevice = {
  pkg: { name: 'input', version: '0.1.0', description: 'Linux input event devices (/dev/input/event*)' },
  async getDrivers() {
    const ops = nodeOperations(inputHub)
    return Devices.map((device, index): KernelCharDevice => ({ name: `input!event${index}`, major: InputMajor, minor: device.minor, class: input_class, ops }))
  }
}
