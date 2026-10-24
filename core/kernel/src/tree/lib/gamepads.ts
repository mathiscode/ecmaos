/**
 * Gamepads as Linux has them: each pad the browser shows is `/dev/input/event<N>` (evdev) and `/dev/input/js<N>` (the
 * joystick API, joydev), with `/dev/input/by-id/usb-<name>-event-joystick` and `-joystick` names for them. A pad gets its
 * nodes when the browser shows it (`gamepadconnected`, which comes once a button has been pressed on it) and loses them when it
 * goes; a program that still has one open gets `ENODEV`, as on Linux.
 *
 * A pad with the browser's "standard" mapping reports Linux's gamepad layout (Documentation/input/gamepad.rst): `BTN_SOUTH`,
 * `BTN_EAST`, `BTN_NORTH`, `BTN_WEST`, the shoulders `BTN_TL` / `BTN_TR`, the triggers both as `BTN_TL2` / `BTN_TR2` and as
 * `ABS_Z` / `ABS_RZ` (0 to 255), `BTN_SELECT`, `BTN_START`, `BTN_MODE`, the stick buttons, the sticks as `ABS_X` / `ABS_Y`
 * and `ABS_RX` / `ABS_RY` (-32768 to 32767) and the d-pad as the hat `ABS_HAT0X` / `ABS_HAT0Y`, as `xpad` does. Any other pad
 * reports its buttons from `BTN_TRIGGER` on and its axes from `ABS_X` on, as a generic HID joystick does. A pad that can
 * vibrate has `EV_FF` with `FF_RUMBLE`: effects are uploaded with `EVIOCSFF`, played by writing an `EV_FF` event, and played
 * by the browser's `vibrationActuator`.
 *
 * Numbers: windows hold `event2` to `event33` (a window's input is `event<2+N>` for its `fb<N>`), so a pad takes the lowest free
 * number from `event34`; `js<N>` is the lowest free from 0. The pads are looked at every 16 ms while one of their nodes is open
 * (the browser has no events for changes).
 */

import { Device, EPOLLIN, EPOLLOUT, WaitQueue } from '@zenfs/linux'
import type { DeviceFile, FileOperations } from '@zenfs/linux'
import { fs } from '@zenfs/core'
import { withErrno } from 'kerium'

import type { KernelDevice } from '@ecmaos/types'

import { ABS_X, ABS_Y, EV_ABS, EV_FF, EV_KEY, EV_SYN, EvdevDevice, InputMajor, KeyboardMinor, SYN_REPORT, addInputDevice, goneOperations, input_class, inputHub, nodeOperations } from './evdev.ts'
import type { AbsInfo, DeviceSpec } from './evdev.ts'
import { registerMinor } from './dynamic-minors.ts'

// codes, from `<linux/input-event-codes.h>`
export const ABS_Z = 0x02, ABS_RX = 0x03, ABS_RY = 0x04, ABS_RZ = 0x05, ABS_HAT0X = 0x10, ABS_HAT0Y = 0x11, ABS_MISC = 0x28
export const BTN_JOYSTICK = 0x120, BTN_SOUTH = 0x130, BTN_EAST = 0x131, BTN_NORTH = 0x133, BTN_WEST = 0x134, BTN_TL = 0x136
export const BTN_TR = 0x137, BTN_TL2 = 0x138, BTN_TR2 = 0x139, BTN_SELECT = 0x13a, BTN_START = 0x13b, BTN_MODE = 0x13c
export const BTN_THUMBL = 0x13d, BTN_THUMBR = 0x13e, BTN_TRIGGER_HAPPY = 0x2c0
export const FF_RUMBLE = 0x50, FF_GAIN = 0x60
const BTN_MISC = 0x100, KEY_MAX = 0x2ff

/** The first event number a pad may take; the ones below are the keyboard, the pointer and the windows' */
export const PadEventBase = 34
/** How many `js<N>` there can be: joydev's minors 0 to 31 */
const JoystickLines = 32
const PollInterval = 16

const Stick: AbsInfo = { min: -32768, max: 32767, fuzz: 16, flat: 128 }
const Trigger: AbsInfo = { min: 0, max: 255 }
const Hat: AbsInfo = { min: -1, max: 1 }

/** The standard mapping's buttons, by index; the d-pad (12 to 15) is the hat, and the triggers (6, 7) are axes too */
const StandardButtons: Readonly<Record<number, number>> = {
  0: BTN_SOUTH, 1: BTN_EAST, 2: BTN_WEST, 3: BTN_NORTH, 4: BTN_TL, 5: BTN_TR, 6: BTN_TL2, 7: BTN_TR2,
  8: BTN_SELECT, 9: BTN_START, 10: BTN_THUMBL, 11: BTN_THUMBR, 16: BTN_MODE
}
const StandardAxes = [ABS_X, ABS_Y, ABS_RX, ABS_RY]
/** A generic joystick's axes, in the order the HID driver gives them out */
const GenericAxes = [ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17]

/** What the page gives for a pad; `navigator.getGamepads()` by default */
interface PadSource {
  id: string
  index: number
  mapping: string
  connected: boolean
  buttons: ReadonlyArray<{ pressed: boolean, value: number }>
  axes: ReadonlyArray<number>
  vibrationActuator?: { playEffect(type: string, params: Record<string, number>): Promise<unknown>, reset?(): Promise<unknown> } | null
}

/** A pad's controls in Linux's terms: the buttons by `BTN_*` code and the axes by `ABS_*` code, with their values */
export interface PadState { keys: Map<number, number>, abs: Map<number, number> }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const stick = (value: number) => clamp(Math.round(value * 32767), -32768, 32767)

/** What `pad` is doing now, in Linux's codes */
export function padState(pad: PadSource): PadState {
  const keys = new Map<number, number>()
  const abs = new Map<number, number>()
  const pressed = (index: number) => pad.buttons[index]?.pressed ? 1 : 0
  if (pad.mapping === 'standard') {
    pad.buttons.forEach((button, index) => {
      if (index >= 12 && index <= 15) return
      const code = StandardButtons[index] ?? BTN_TRIGGER_HAPPY + index - 17
      keys.set(code, button.pressed ? 1 : 0)
    })
    StandardAxes.forEach((code, index) => abs.set(code, stick(pad.axes[index] ?? 0)))
    pad.axes.slice(4).forEach((value, index) => abs.set(ABS_MISC + index, stick(value)))
    abs.set(ABS_Z, Math.round(clamp(pad.buttons[6]?.value ?? 0, 0, 1) * 255))
    abs.set(ABS_RZ, Math.round(clamp(pad.buttons[7]?.value ?? 0, 0, 1) * 255))
    if (pad.buttons.length > 15) {
      abs.set(ABS_HAT0X, pressed(15) - pressed(14))
      abs.set(ABS_HAT0Y, pressed(13) - pressed(12))
    }
  } else {
    pad.buttons.forEach((button, index) => keys.set(index < 16 ? BTN_JOYSTICK + index : BTN_TRIGGER_HAPPY + index - 16, button.pressed ? 1 : 0))
    pad.axes.forEach((value, index) => abs.set(GenericAxes[index] ?? ABS_MISC + index - GenericAxes.length, stick(value)))
  }
  return { keys, abs }
}

const absInfoOf = (pad: PadSource, code: number): AbsInfo =>
  pad.mapping === 'standard' && (code === ABS_Z || code === ABS_RZ) ? Trigger : code === ABS_HAT0X || code === ABS_HAT0Y ? Hat : Stick

/** The vendor, product and name in a browser's pad id: Chrome's `NAME (... Vendor: 054c Product: 09cc)`, Firefox's `054c-09cc-NAME` */
export function parsePadId(id: string): { vendor: number, product: number, name: string } {
  const chrome = /^(.*?)\s*\((?:.*?)Vendor: ([0-9a-f]{1,4}) Product: ([0-9a-f]{1,4})\)\s*$/i.exec(id)
  if (chrome) return { name: chrome[1]!.trim() || 'Gamepad', vendor: parseInt(chrome[2]!, 16), product: parseInt(chrome[3]!, 16) }
  const firefox = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-(.+)$/i.exec(id)
  if (firefox) return { name: firefox[3]!.trim(), vendor: parseInt(firefox[1]!, 16), product: parseInt(firefox[2]!, 16) }
  return { name: id.replace(/\s*\(.*\)\s*$/, '').trim() || 'Gamepad', vendor: 0, product: 0 }
}

// - force feedback --------------------------------------------------------------------------------------

/** What an uploaded `FF_RUMBLE` effect does: `struct ff_effect`, 44 bytes here, `replay` at 10 and the union at 16 */
interface Rumble { strong: number, weak: number, length: number, delay: number }

function forceFeedback(pad: () => PadSource | undefined): NonNullable<DeviceSpec['ff']> {
  const effects = new Map<number, Rumble>()
  let gain = 0xffff
  const Slots = 16
  return {
    effects: Slots,
    upload(effect) {
      const view = new DataView(effect.buffer, effect.byteOffset, effect.byteLength)
      if (view.getUint16(0, true) !== FF_RUMBLE) throw withErrno('EINVAL', 'only FF_RUMBLE')
      let id = view.getInt16(2, true)
      if (id === -1) {
        id = 0
        while (effects.has(id)) id++
        if (id >= Slots) throw withErrno('ENOSPC')
      } else if (!effects.has(id)) throw withErrno('EINVAL')
      effects.set(id, { length: view.getUint16(10, true), delay: view.getUint16(12, true), strong: view.getUint16(16, true), weak: view.getUint16(18, true) })
      const out = effect.slice()
      new DataView(out.buffer).setInt16(2, id, true)
      return out
    },
    erase(id) {
      if (!effects.delete(id)) throw withErrno('EINVAL')
    },
    play(code, value) {
      const actuator = pad()?.vibrationActuator
      if (!actuator) return
      if (code === FF_GAIN) { gain = clamp(value, 0, 0xffff); return }
      const effect = effects.get(code)
      if (!effect) return
      if (value <= 0) { void actuator.reset?.()?.catch(() => {}); return }
      const scale = (magnitude: number) => (magnitude / 0xffff) * (gain / 0xffff)
      // a length of 0 plays for as long as the browser lets one effect go
      void actuator.playEffect('dual-rumble', {
        duration: clamp((effect.length || 5000) * value, 0, 5000),
        startDelay: effect.delay,
        strongMagnitude: scale(effect.strong),
        weakMagnitude: scale(effect.weak)
      }).catch(() => {})
    }
  }
}

// - the joystick API -------------------------------------------------------------------------------------

export const JS_EVENT_BUTTON = 0x01, JS_EVENT_AXIS = 0x02, JS_EVENT_INIT = 0x80
const JsEventSize = 8

function jsEvent(time: number, value: number, type: number, number: number): Uint8Array {
  const out = new Uint8Array(JsEventSize)
  const view = new DataView(out.buffer)
  view.setUint32(0, time >>> 0, true)
  view.setInt16(4, value, true)
  out[6] = type
  out[7] = number
  return out
}

/** joydev's buttons: from `BTN_JOYSTICK` up first, then the ones from `BTN_MISC` below it; its axes in code order */
const joydevButtons = (codes: number[]) => [...codes.filter(code => code >= BTN_JOYSTICK).sort((a, b) => a - b), ...codes.filter(code => code < BTN_JOYSTICK).sort((a, b) => a - b)]

/** An axis as joydev scales it: its range onto -32767 to 32767 */
function joydevAxis(info: AbsInfo, value: number): number {
  if (info.max === info.min) return 0
  return clamp(Math.round(((value - info.min) * 65534) / (info.max - info.min) - 32767), -32767, 32767)
}

// - pads ---------------------------------------------------------------------------------------------------

interface Pad {
  index: number
  name: string
  event: number
  js: number
  spec: DeviceSpec
  state: PadState
  buttons: number[]
  axes: number[]
  /** The joystick node's readers: events waiting, and the queue a reader sleeps on */
  js_events: Uint8Array[]
  js_queue: WaitQueue
  js_open: number
  byId: string[]
  remove: () => void
}

const pads = new Map<number, Pad>()
let getGamepads: () => ArrayLike<PadSource | null> = () =>
  ((globalThis as { navigator?: { getGamepads?: () => ArrayLike<PadSource | null> } }).navigator?.getGamepads?.() ?? [])
let log: ((line: string) => void) | undefined
let timer: ReturnType<typeof setInterval> | undefined

/**
 * Marks `/dev/input` changed, as Linux does when an entry comes or goes; devtmpfs leaves a directory's times alone. A program
 * without inotify (SDL) rescans when the mtime, in whole seconds, differs from the last it saw, so each change moves it on by
 * a second at least.
 */
let inputChanged = 0
function touchInput() {
  inputChanged = Math.max(Date.now(), inputChanged + 1000)
  // the synchronous call opens the path, which a directory refuses
  void fs.promises.utimes('/dev/input', inputChanged / 1000, inputChanged / 1000).catch(() => { /* no /dev/input yet */ })
}

const sourceOf = (pad: Pad) => getGamepads()[pad.index] ?? undefined
const eventMinor = (event: number) => KeyboardMinor + event

function lowest(taken: Iterable<number>, from: number) {
  const used = new Set(taken)
  let n = from
  while (used.has(n)) n++
  return n
}

/** Whether anything has one of the pads' nodes open, and so whether they need looking at */
const listened = () => [...pads.values()].some(pad => pad.js_open > 0 || inputHub.listening(eventMinor(pad.event)))

function poll() {
  for (const pad of pads.values()) {
    const source = sourceOf(pad)
    if (!source || !source.connected) continue
    const next = padState(source)
    const now = Date.now()
    const events: [number, number, number][] = []
    for (const [code, value] of next.keys) if (pad.state.keys.get(code) !== value) events.push([EV_KEY, code, value])
    for (const [code, value] of next.abs) if (pad.state.abs.get(code) !== value) events.push([EV_ABS, code, value])
    if (!events.length) continue
    inputHub.report(eventMinor(pad.event), events, now)
    if (pad.js_open > 0) {
      for (const [type, code, value] of events) {
        const number = type === EV_KEY ? pad.buttons.indexOf(code) : pad.axes.indexOf(code)
        if (number < 0) continue
        pad.js_events.push(type === EV_KEY ? jsEvent(now, value, JS_EVENT_BUTTON, number) : jsEvent(now, joydevAxis(absInfoOf(source, code), value), JS_EVENT_AXIS, number))
      }
      while (pad.js_events.length > 1024) pad.js_events.shift()
      pad.js_queue.wake_up()
    }
    pad.state = next
  }
  if (!listened()) { clearInterval(timer); timer = undefined }
}

/** Starts looking at the pads, if anything has their nodes open; called when a node is opened */
function watch() {
  if (timer || !listened()) return
  // from what they are doing now, so the first look reports only what changes after it
  for (const pad of pads.values()) { const source = sourceOf(pad); if (source) pad.state = padState(source) }
  timer = setInterval(poll, PollInterval)
  ;(timer as { unref?: () => void }).unref?.()
}

/** An event node of a pad: the event device's operations, and opening one starts the looking */
const eventOperations: FileOperations = (() => {
  const base = nodeOperations()
  return { ...base, open: file => { base.open?.(file); watch() } }
})()

const jsPad = (file: DeviceFile) => [...pads.values()].find(pad => pad.js === file.devt.minor)

/** `/dev/input/js<N>`: 8-byte `struct js_event`s, the pad's state first (with `JS_EVENT_INIT`), then each change */
const joystickOperations: FileOperations = {
  open(file) {
    const pad = jsPad(file)
    if (!pad) return
    if (pad.js_open++ === 0) {
      const source = sourceOf(pad)
      if (source) pad.state = padState(source)
      const now = Date.now()
      pad.js_events = [
        ...pad.buttons.map((code, number) => jsEvent(now, pad.state.keys.get(code) ?? 0, JS_EVENT_BUTTON | JS_EVENT_INIT, number)),
        ...pad.axes.map((code, number) => jsEvent(now, source ? joydevAxis(absInfoOf(source, code), pad.state.abs.get(code) ?? 0) : 0, JS_EVENT_AXIS | JS_EVENT_INIT, number))
      ]
    }
    watch()
  },
  release(file) {
    const pad = jsPad(file)
    if (pad && pad.js_open > 0 && --pad.js_open === 0) pad.js_events = []
  },
  read(file, buffer, start, end) {
    const pad = jsPad(file)
    if (!pad) throw withErrno('ENODEV')
    if (end - start < JsEventSize) throw withErrno('EINVAL')
    let done = 0
    while (pad.js_events.length && done + JsEventSize <= end - start) {
      buffer.set(pad.js_events.shift()!, start + done)
      done += JsEventSize
    }
    return done
  },
  write: () => { throw withErrno('EINVAL') },
  poll: file => { const pad = jsPad(file); return (!pad || pad.js_events.length ? EPOLLIN : 0) | EPOLLOUT },
  poll_wait: file => jsPad(file)?.js_queue ?? goneQueue,
  ioctl: new Proxy({}, {
    get: (_target, key) => {
      const request = Number(key)
      if (!Number.isInteger(request) || ((request >>> 8) & 0xff) !== 0x6a) return undefined
      return (_context: unknown, file: DeviceFile) => {
        const pad = jsPad(file)
        if (!pad) throw withErrno('ENODEV')
        const answer = joystickIoctl(pad, request)
        if (!answer) throw withErrno('EINVAL')
        return answer
      }
    },
    has: (_target, key) => Number.isInteger(Number(key)) && ((Number(key) >>> 8) & 0xff) === 0x6a
  }) as FileOperations['ioctl']
}
const goneQueue = new WaitQueue()

/** `JSIOC*`: the version, the number of axes and buttons, the name, and which `ABS_*` / `BTN_*` code each one is */
function joystickIoctl(pad: Pad, request: number): Uint8Array | undefined {
  const number = request & 0xff
  const size = (request >>> 16) & 0x3fff
  switch (number) {
    case 0x01: { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, 0x020100, true); return out } // JSIOCGVERSION
    case 0x11: return new Uint8Array([pad.axes.length]) // JSIOCGAXES
    case 0x12: return new Uint8Array([pad.buttons.length]) // JSIOCGBUTTONS
    case 0x13: { // JSIOCGNAME(len)
      const name = new TextEncoder().encode(pad.name)
      const out = new Uint8Array(Math.min(size, name.length + 1))
      out.set(name.subarray(0, Math.max(0, out.length - 1)))
      return out
    }
    case 0x32: { const out = new Uint8Array(0x40); pad.axes.forEach((code, i) => { out[i] = code }); return out.subarray(0, Math.min(size, 0x40)) } // JSIOCGAXMAP
    case 0x34: { // JSIOCGBTNMAP: __u16[KEY_MAX - BTN_MISC + 1]
      const out = new Uint8Array((KEY_MAX - BTN_MISC + 1) * 2)
      const view = new DataView(out.buffer)
      pad.buttons.forEach((code, i) => view.setUint16(i * 2, code, true))
      return out.subarray(0, Math.min(size, out.length))
    }
    default: return undefined
  }
}

const byIdName = (name: string) => `usb-${name.replace(/[^A-Za-z0-9.+-]+/g, '_').replace(/^_+|_+$/g, '') || 'Gamepad'}`

async function linkById(pad: Pad) {
  const taken = new Set([...pads.values()].filter(other => other !== pad).flatMap(other => other.byId))
  let base = byIdName(pad.name)
  for (let n = 2; taken.has(`${base}-event-joystick`); n++) base = `${byIdName(pad.name)}-${n}`
  pad.byId = [`${base}-event-joystick`, `${base}-joystick`]
  await fs.promises.mkdir('/dev/input/by-id', { recursive: true })
  await fs.promises.symlink(`../event${pad.event}`, `/dev/input/by-id/${pad.byId[0]}`)
  await fs.promises.symlink(`../js${pad.js}`, `/dev/input/by-id/${pad.byId[1]}`)
}

/** Gives the pad at `index` its nodes, unless it has them */
export function attachPad(index: number): Pad | undefined {
  if (pads.has(index)) return pads.get(index)
  const source = getGamepads()[index]
  if (!source || !source.connected) return undefined
  const { name, vendor, product } = parsePadId(source.id)
  const event = lowest([...pads.values()].map(pad => pad.event), PadEventBase)
  const js = lowest([...pads.values()].map(pad => pad.js), 0)
  if (js >= JoystickLines) return undefined
  const state = padState(source)
  const keys = [...state.keys.keys()]
  const axes = [...state.abs.keys()]
  const abs: Record<number, AbsInfo> = Object.fromEntries(axes.map(code => [code, absInfoOf(source, code)]))
  // what the spec answers comes from the pad once it is made
  const self = () => pads.get(index)
  const ff = source.vibrationActuator ? forceFeedback(() => { const pad = self(); return pad && sourceOf(pad) }) : undefined
  const spec: DeviceSpec = {
    name,
    minor: eventMinor(event),
    types: [EV_SYN, EV_KEY, EV_ABS, ...(ff ? [EV_FF] : [])],
    codes: { [EV_SYN]: [SYN_REPORT], [EV_KEY]: keys, [EV_ABS]: axes, ...(ff ? { [EV_FF]: [FF_RUMBLE, FF_GAIN] } : {}) } as Record<number, number[]>,
    // a pad whose ids the browser gives is a USB one; one it does not is a virtual device
    id: vendor ? [0x03, vendor, product, 0x0111] : [0x06, 0, 0, 0],
    abs,
    value: code => self()?.state.abs.get(code) ?? 0,
    down: () => [...self()?.state.keys ?? []].filter(([, value]) => value).map(([code]) => code),
    ...(ff ? { ff } : {})
  }
  const removeEvent = addInputDevice(`event${event}`, spec, eventOperations)
  registerMinor(InputMajor, js, joystickOperations)
  let jsDevice: Device | undefined
  try {
    jsDevice = new Device({ name: `input!js${js}`, class: input_class, dev_t: { major: InputMajor, minor: js } })
    jsDevice.register()
  } catch { jsDevice = undefined /* no input major here */ }
  const removeJs = () => { try { jsDevice?.unregister() } catch { /* gone */ } }
  const pad: Pad = {
    index, name, event, js, spec, state, buttons: joydevButtons(keys), axes: [...axes].sort((a, b) => a - b),
    js_events: [], js_queue: new WaitQueue(), js_open: 0, byId: [],
    remove: () => { removeEvent(); registerMinor(InputMajor, js, goneOperations); removeJs() }
  }
  pads.set(index, pad)
  touchInput()
  void linkById(pad).catch(() => { /* the names in /dev/input are enough */ })
  log?.(`input: ${name} as /dev/input/event${event}${vendor ? ` (${vendor.toString(16).padStart(4, '0')}:${product.toString(16).padStart(4, '0')})` : ''}`)
  return pad
}

/** Takes the pad at `index` away: its nodes go, and whoever has them open gets `ENODEV` */
export function detachPad(index: number): void {
  const pad = pads.get(index)
  if (!pad) return
  pads.delete(index)
  pad.spec.gone = true
  pad.remove()
  touchInput()
  pad.js_queue.wake_up()
  for (const name of pad.byId) void fs.promises.unlink(`/dev/input/by-id/${name}`).catch(() => {})
  log?.(`input: ${pad.name} (event${pad.event}) disconnected`)
}

/** The pads that have nodes, for diagnostics and tests: index, event number, js number, name, and whether js<N> is open */
export function padNodes(): { index: number, event: number, js: number, name: string, jsOpen: boolean }[] {
  return [...pads.values()].map(({ index, event, js, name, js_open }) => ({ index, event, js, name, jsOpen: js_open > 0 }))
}

/** Starts watching for pads (once per realm): the ones already there get their nodes, and connects and disconnects add and remove them */
let installed = false
export function installGamepads(options: { log?: (line: string) => void, getGamepads?: () => ArrayLike<PadSource | null> } = {}) {
  log = options.log
  if (options.getGamepads) getGamepads = options.getGamepads
  if (installed) return
  installed = true
  const target = globalThis as { addEventListener?: (name: string, listener: (event: Event) => void) => void }
  target.addEventListener?.('gamepadconnected', event => { attachPad((event as GamepadEvent).gamepad.index) })
  target.addEventListener?.('gamepaddisconnected', event => { detachPad((event as GamepadEvent).gamepad.index) })
  const already = getGamepads()
  for (let index = 0; index < already.length; index++) if (already[index]?.connected) attachPad(index)
}

/** `/dev/input`: the keyboard's, the pointer's and the windows' event devices (`evdev.ts`), and the pads' */
export const InputDevice: KernelDevice = {
  pkg: EvdevDevice.pkg,
  async getDrivers(ctx) {
    installGamepads({ log: line => ctx.log.info(line) })
    return await EvdevDevice.getDrivers(ctx)
  }
}
