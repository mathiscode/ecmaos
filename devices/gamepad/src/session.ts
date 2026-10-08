/// <reference types="w3c-gamepad" />

/**
 * A gamepad as a device session: a stream of events in the layout of Linux's joystick API (`struct js_event`, 8 bytes: u32
 * time in ms, i16 value, u8 type, u8 number; little endian), so what reads `/dev/js0` there reads this. Type 1 is a button
 * (value 0 or 1), type 2 an axis (-32767 to 32767), and the state the pad is in when opened comes first with 0x80 added to
 * the type. Reads only; the control `rumble` drives the vibration motors.
 */

type Plain = string | number | boolean | null | Uint8Array | Plain[] | { [key: string]: Plain }

export interface GamepadDeviceSession {
  info: { kind: string, read: boolean, write: boolean, [key: string]: Plain }
  read(): Promise<Uint8Array | undefined>
  control(op: string, args: Plain[]): Promise<Plain>
  emit?: (name: string, data: Plain) => void
  close(): Promise<void>
}

export class GamepadError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'GamepadError'
  }
}

export const JS_EVENT_BUTTON = 0x01
export const JS_EVENT_AXIS = 0x02
export const JS_EVENT_INIT = 0x80

export function jsEvent(time: number, value: number, type: number, number: number): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(0, time >>> 0, true)
  view.setInt16(4, value, true)
  out[6] = type
  out[7] = number
  return out
}

export interface GamepadSessionOptions {
  /** How often the pad is looked at (the API has no events for changes); default 16 ms */
  interval?: number
  /** Where pads are found; default `navigator.getGamepads` */
  getGamepads?: () => ArrayLike<Gamepad | null>
}

const axisValue = (value: number) => Math.max(-32767, Math.min(32767, Math.round(value * 32767)))

export async function openGamepadSession(index: number, options: GamepadSessionOptions = {}): Promise<GamepadDeviceSession> {
  const getGamepads = options.getGamepads ?? (() => (globalThis as { navigator?: Navigator }).navigator?.getGamepads?.() ?? [])
  const first = getGamepads()[index]
  if (!first) throw new GamepadError('ENODEV', `no gamepad ${index} (press a button on it first)`)
  const started = Date.now()
  const queue: Uint8Array[] = []
  let waiting: ((chunk: Uint8Array | undefined) => void) | undefined
  let closed = false
  const limit = 1024
  const push = (event: Uint8Array) => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(event) } else {
      queue.push(event)
      if (queue.length > limit) queue.shift()
    }
  }
  const now = () => Date.now() - started

  const buttons = first.buttons.map(button => button.pressed ? 1 : 0)
  const axes = first.axes.map(axisValue)
  buttons.forEach((value, number) => push(jsEvent(0, value, JS_EVENT_BUTTON | JS_EVENT_INIT, number)))
  axes.forEach((value, number) => push(jsEvent(0, value, JS_EVENT_AXIS | JS_EVENT_INIT, number)))

  let timer: ReturnType<typeof setInterval> | undefined
  const finish = () => { if (closed) return; closed = true; if (timer) clearInterval(timer); waiting?.(undefined); waiting = undefined }
  timer = setInterval(() => {
    const pad = getGamepads()[index]
    if (!pad || !pad.connected) { session.emit?.('disconnect', null); finish(); return }
    const time = now()
    pad.buttons.forEach((button, number) => {
      const value = button.pressed ? 1 : 0
      if (buttons[number] !== value) { buttons[number] = value; push(jsEvent(time, value, JS_EVENT_BUTTON, number)) }
    })
    pad.axes.forEach((raw, number) => {
      const value = axisValue(raw)
      if (axes[number] !== value) { axes[number] = value; push(jsEvent(time, value, JS_EVENT_AXIS, number)) }
    })
  }, options.interval ?? 16)

  const session: GamepadDeviceSession = {
    info: { kind: 'gamepad', read: true, write: false, id: first.id, mapping: first.mapping, buttons: first.buttons.length, axes: first.axes.length },
    read: () => new Promise<Uint8Array | undefined>(resolve => {
      const next = queue.shift()
      if (next) resolve(next)
      else if (closed) resolve(undefined)
      else waiting = resolve
    }),
    async control(op, args) {
      switch (op) {
        case 'rumble': {
          const pad = getGamepads()[index] as (Gamepad & { vibrationActuator?: { playEffect(type: string, params: Record<string, number>): Promise<unknown> } }) | null
          if (!pad?.vibrationActuator) throw new GamepadError('ENOTSUP', 'this gamepad cannot vibrate')
          const given = args[0]
          const params = given && typeof given === 'object' && !Array.isArray(given) && !(given instanceof Uint8Array) ? given as { [key: string]: Plain } : {}
          const number = (key: string, fallback: number, max: number) => {
            const value = params[key]
            return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback
          }
          await pad.vibrationActuator.playEffect('dual-rumble', { duration: number('duration', 200, 5000), strongMagnitude: number('strong', 1, 1), weakMagnitude: number('weak', 1, 1) })
          return null
        }
        default: throw new GamepadError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
      }
    },
    async close() { finish() }
  }
  return session
}
