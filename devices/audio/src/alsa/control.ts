/**
 * `/dev/snd/controlC0`: the card's control interface (`sound/asound.h`, type `'U'`). It tells a program what the card is, what
 * PCM devices it has, and gives it the mixer's controls (see `mixer.ts`), which is all `amixer`, `alsamixer` and alsa-lib's
 * `hw:` plugin ask of it. Laid out for a WALI program.
 */

import { withErrno } from 'kerium'
import type { DeviceSession } from '@ecmaos-devices/session'

import { VolumeMax, mixer } from './mixer.js'
import type { MixerControl } from './mixer.js'
import { pcmInfoBytes } from './pcm.js'

export const ControlType = 0x55 // 'U'
export const controlRequest = (request: number) => ((request >>> 8) & 0xff) === ControlType

const PVERSION = 0x00, CARD_INFO = 0x01
const ELEM_LIST = 0x10, ELEM_INFO = 0x11, ELEM_READ = 0x12, ELEM_WRITE = 0x13, ELEM_LOCK = 0x14, ELEM_UNLOCK = 0x15, SUBSCRIBE_EVENTS = 0x16
const ELEM_ADD = 0x17, ELEM_REPLACE = 0x18, ELEM_REMOVE = 0x19, TLV_READ = 0x1a, TLV_WRITE = 0x1b, TLV_COMMAND = 0x1c
const HWDEP_NEXT_DEVICE = 0x20, HWDEP_INFO = 0x21, PCM_NEXT_DEVICE = 0x30, PCM_INFO = 0x31, PCM_PREFER_SUBDEVICE = 0x32
const RAWMIDI_NEXT_DEVICE = 0x40, RAWMIDI_INFO = 0x41, RAWMIDI_PREFER_SUBDEVICE = 0x42
const UMP_NEXT_DEVICE = 0x43, UMP_ENDPOINT_INFO = 0x44, UMP_BLOCK_INFO = 0x45
const POWER = 0xd0, POWER_STATE = 0xd1

/** The protocol version of the control interface (2.0.9) */
const ProtocolVersion = 0x00020009
const IFACE_MIXER = 2
const TYPE_BOOLEAN = 1, TYPE_INTEGER = 2
const ACCESS_READWRITE = 3

/** How many entries of `struct snd_ctl_elem_id` (64 bytes) `ELEM_LIST` hands over after its own 72 bytes */
export const ElemIdSize = 64
export const ElemListSize = 72

const argument = (arg: unknown, size: number) => {
  const out = new Uint8Array(size)
  if (ArrayBuffer.isView(arg)) out.set(new Uint8Array(arg.buffer, arg.byteOffset, Math.min(arg.byteLength, size)))
  return out
}

const text = (out: Uint8Array, at: number, length: number, value: string) => {
  out.fill(0, at, at + length)
  out.set(new TextEncoder().encode(value).subarray(0, length - 1), at)
}

const textAt = (bytes: Uint8Array, at: number, length: number) => new TextDecoder().decode(bytes.subarray(at, at + length)).replace(/\0.*$/s, '')

function putId(out: Uint8Array, at: number, control: MixerControl) {
  const view = new DataView(out.buffer, out.byteOffset)
  view.setUint32(at, control.numid, true)
  view.setInt32(at + 4, IFACE_MIXER, true)
  view.setUint32(at + 8, 0, true)
  view.setUint32(at + 12, 0, true)
  text(out, at + 16, 44, control.name)
  view.setUint32(at + 60, 0, true)
}

/** The control a `struct snd_ctl_elem_id` at `at` names: by number if it has one, else by interface, name and index */
function find(bytes: Uint8Array, at = 0): MixerControl {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const numid = view.getUint32(at, true)
  const found = numid ? mixer.find(numid) : view.getInt32(at + 4, true) === IFACE_MIXER && view.getUint32(at + 60, true) === 0 ? mixer.byName(textAt(bytes, at + 16, 44)) : undefined
  if (!found) throw withErrno('ENOENT')
  return found
}

export class ControlStream implements DeviceSession {
  readonly info = { kind: 'alsa-control', read: false, write: false }
  private closed = false

  async ioctl(request: number, arg: unknown): Promise<Uint8Array | number> {
    if (this.closed) throw withErrno('ENODEV')
    switch (request & 0xff) {
      case PVERSION: return this.int(ProtocolVersion)
      case CARD_INFO: return this.cardInfo(argument(arg, 376))
      case ELEM_LIST: return this.list(argument(arg, ElemListSize))
      case ELEM_INFO: return this.elemInfo(argument(arg, 272))
      case ELEM_READ: return this.elemRead(argument(arg, 1224))
      case ELEM_WRITE: return this.elemWrite(argument(arg, 1224))
      case ELEM_LOCK: case ELEM_UNLOCK: return 0
      case SUBSCRIBE_EVENTS: return this.int(0)
      case ELEM_ADD: case ELEM_REPLACE: case ELEM_REMOVE: throw withErrno('EPERM')
      case TLV_READ: case TLV_WRITE: case TLV_COMMAND: throw withErrno('ENXIO')
      case HWDEP_NEXT_DEVICE: case RAWMIDI_NEXT_DEVICE: case UMP_NEXT_DEVICE: return this.int(-1)
      case HWDEP_INFO: case RAWMIDI_INFO: case UMP_ENDPOINT_INFO: case UMP_BLOCK_INFO: throw withErrno('ENOENT')
      case PCM_NEXT_DEVICE: return this.int(new DataView(argument(arg, 4).buffer).getInt32(0, true) < 0 ? 0 : -1)
      case PCM_INFO: return this.pcmInfo(argument(arg, 288))
      case PCM_PREFER_SUBDEVICE: case RAWMIDI_PREFER_SUBDEVICE: return 0
      case POWER: case POWER_STATE: throw withErrno('ENOTTY')
      default: throw withErrno('ENOTTY')
    }
  }

  private int(value: number) {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setInt32(0, value, true)
    return out
  }

  private cardInfo(out: Uint8Array) {
    // struct snd_ctl_card_info { i32 card; i32 pad; u8 id[16], driver[16], name[32], longname[80], reserved_[16], mixername[80], components[128]; }
    out.fill(0)
    text(out, 8, 16, 'Web')
    text(out, 24, 16, 'ecmaos-audio')
    text(out, 40, 32, 'Web Audio')
    text(out, 72, 80, 'ecmaOS Web Audio (the browser\'s speakers and microphone)')
    text(out, 168, 80, 'Web Audio Mixer')
    text(out, 248, 128, '')
    return out
  }

  private list(out: Uint8Array) {
    // struct snd_ctl_elem_list { u32 offset, space, used, count; struct snd_ctl_elem_id *pids; ... }: the ids follow the structure in the answer
    const view = new DataView(out.buffer)
    const offset = view.getUint32(0, true), space = view.getUint32(4, true)
    const controls = mixer.controls
    const used = Math.max(0, Math.min(space, controls.length - offset))
    view.setUint32(8, used, true)
    view.setUint32(12, controls.length, true)
    const answer = new Uint8Array(ElemListSize + used * ElemIdSize)
    answer.set(out)
    for (let index = 0; index < used; index++) putId(answer, ElemListSize + index * ElemIdSize, controls[offset + index]!)
    return answer
  }

  private pcmInfo(out: Uint8Array) {
    const view = new DataView(out.buffer)
    const device = view.getUint32(0, true), subdevice = view.getUint32(4, true), stream = view.getInt32(8, true)
    if (device !== 0 || subdevice !== 0 || (stream !== 0 && stream !== 1)) throw withErrno('ENOENT')
    return pcmInfoBytes(out, stream === 0)
  }

  private elemInfo(out: Uint8Array) {
    // struct snd_ctl_elem_info { struct snd_ctl_elem_id id; i32 type; u32 access, count; i32 owner; union { struct { long min, max, step; } integer; ... } value; ... }
    const control = find(out)
    const view = new DataView(out.buffer)
    putId(out, 0, control)
    view.setInt32(64, control.type === 'boolean' ? TYPE_BOOLEAN : TYPE_INTEGER, true)
    view.setUint32(68, ACCESS_READWRITE, true)
    view.setUint32(72, 2, true)
    view.setInt32(76, 0, true)
    if (control.type === 'integer') {
      view.setBigInt64(80, 0n, true)
      view.setBigInt64(88, BigInt(VolumeMax), true)
      view.setBigInt64(96, 0n, true)
    }
    return out
  }

  private elemRead(out: Uint8Array) {
    // struct snd_ctl_elem_value { struct snd_ctl_elem_id id; u32 indirect; pad; union { struct { long value[128]; } integer; ... } value; ... }
    const control = find(out)
    const view = new DataView(out.buffer)
    putId(out, 0, control)
    control.values.forEach((value, index) => view.setBigInt64(72 + index * 8, BigInt(value), true))
    return out
  }

  private elemWrite(out: Uint8Array) {
    const control = find(out)
    const view = new DataView(out.buffer)
    for (const index of [0, 1] as const) mixer.set(control, index, Number(view.getBigInt64(72 + index * 8, true)))
    return this.elemRead(out)
  }

  async close() { this.closed = true }
}
