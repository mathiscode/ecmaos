/**
 * A `/dev/snd/pcmC0D0p` (speakers) or `pcmC0D0c` (microphone) node: the ioctls of ALSA's PCM interface (`sound/asound.h`, type
 * `'A'`), answered by a stream that plays to or records from Web Audio. Laid out for a WALI program (`long` is 8 bytes, a pointer
 * 4, `time_t` 64 bits).
 *
 * Samples move by `SNDRV_PCM_IOCTL_WRITEI_FRAMES` and `READI_FRAMES`, so a program needs no memory shared with the device: the
 * node offers no mmap access, and alsa-lib falls back to `SNDRV_PCM_IOCTL_SYNC_PTR` for the pointers it would have read from the
 * mapped status and control pages. The stream keeps the pointers a ring buffer would: `appl_ptr` is the frames a program has
 * written (or read), `hw_ptr` the frames played (or captured), and the buffer is the room between them, so a writer waits when
 * it is full and the sound is heard as the clock reaches it. Playing is the audio clock's: a stream that runs dry is an xrun
 * (`EPIPE`), as on Linux, and the program recovers with `PREPARE`.
 */

import { EPOLLIN, EPOLLOUT, WaitQueue } from '@zenfs/linux'
import { withErrno } from 'kerium'
import type { DeviceSession } from '@ecmaos-devices/session'

import type { AudioEnvironment } from '../session.js'
import {
  FORMAT_FLOAT_LE, FORMAT_S16_LE, FORMAT_S24_3LE, FORMAT_S32_LE, FORMAT_S8, FORMAT_U8,
  HwParamsSize, bytesOf, choose, parseHwParams, refine, writeHwParams
} from './hw.js'
import type { Stream } from './hw.js'
import { mixer } from './mixer.js'

export const PcmType = 0x41 // 'A'

export const PcmState = { open: 0, setup: 1, prepared: 2, running: 3, xrun: 4, draining: 5, paused: 6, suspended: 7, disconnected: 8 } as const
type State = typeof PcmState[keyof typeof PcmState]

const EPOLLERR = 0x8

/** The protocol version of the PCM interface (2.0.17) */
const ProtocolVersion = 0x00020011

const PVERSION = 0x00, INFO = 0x01, TSTAMP = 0x02, TTSTAMP = 0x03, USER_PVERSION = 0x04
const HW_REFINE = 0x10, HW_PARAMS = 0x11, HW_FREE = 0x12, SW_PARAMS = 0x13
const STATUS = 0x20, DELAY = 0x21, HWSYNC = 0x22, SYNC_PTR = 0x23, STATUS_EXT = 0x24, CHANNEL_INFO = 0x32
const PREPARE = 0x40, RESET = 0x41, START = 0x42, DROP = 0x43, DRAIN = 0x44, PAUSE = 0x45, REWIND = 0x46, RESUME = 0x47, XRUN = 0x48, FORWARD = 0x49
const WRITEI_FRAMES = 0x50, READI_FRAMES = 0x51, WRITEN_FRAMES = 0x52, READN_FRAMES = 0x53, LINK = 0x60, UNLINK = 0x61
/** ecmaOS's own: the bytes in one frame of the stream, which the host needs to know how much of a program's memory `WRITEI_FRAMES` or `READI_FRAMES` is about */
export const FRAME_BYTES = 0xf0

const SYNC_PTR_APPL = 2, SYNC_PTR_AVAIL_MIN = 4

export const pcmRequest = (request: number) => ((request >>> 8) & 0xff) === PcmType
export const frameBytesRequest = ((2 << 30) | (4 << 16) | (PcmType << 8) | FRAME_BYTES) >>> 0

/** The frames a request moves, which sit after its `struct snd_xferi` (24 bytes: result, buffer, frames) in what the host hands over */
export const XferHeader = 24

/** A run of seconds lead before the first frame of a stream is heard, so the ones queued behind it are in place */
const StartLead = 0.02
/** Longest a wait for room, for the clock, or for a microphone lasts before the state is looked at again, in milliseconds */
const WaitSlice = 250
/** What `boundary` is before a stream has one: pointers never wrap that far in practice */
const BoundaryLimit = 2 ** 53

export interface PcmOptions {
  direction: 'playback' | 'capture'
  environment: AudioEnvironment
  /** The minor number of the node: 16 + device for playback, 24 + device for capture */
  minor: number
  onError?: (error: Error) => void
}

interface Sw {
  tstampMode: number
  periodStep: number
  sleepMin: number
  availMin: number
  xferAlign: number
  startThreshold: number
  stopThreshold: number
  silenceThreshold: number
  silenceSize: number
  boundary: number
  tstampType: number
}

const argument = (arg: unknown, size: number) => {
  const out = new Uint8Array(size)
  if (ArrayBuffer.isView(arg)) out.set(new Uint8Array(arg.buffer, arg.byteOffset, Math.min(arg.byteLength, size)))
  return out
}

const u64 = (view: DataView, at: number) => Number(view.getBigUint64(at, true))
const putU64 = (view: DataView, at: number, value: number) => view.setBigUint64(at, BigInt(Math.max(0, Math.trunc(value))), true)
const putI64 = (view: DataView, at: number, value: number) => view.setBigInt64(at, BigInt(Math.trunc(value)), true)

const text = (out: Uint8Array, at: number, length: number, value: string) => {
  out.fill(0, at, at + length)
  out.set(new TextEncoder().encode(value).subarray(0, length - 1), at)
}

/** Interleaved samples of `format` as one array of floats (-1 to 1) */
export function toFloats(bytes: Uint8Array, format: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = bytesOf(format) ?? 2
  const count = Math.floor(bytes.byteLength / size)
  const out = new Float32Array(count)
  for (let index = 0; index < count; index++) {
    const at = index * size
    switch (format) {
      case FORMAT_S8: out[index] = view.getInt8(at) / 128; break
      case FORMAT_U8: out[index] = (view.getUint8(at) - 128) / 128; break
      case FORMAT_S16_LE: out[index] = view.getInt16(at, true) / 32768; break
      case FORMAT_S24_3LE: out[index] = ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16))) / 8388608; break
      case FORMAT_S32_LE: out[index] = view.getInt32(at, true) / 2147483648; break
      case FORMAT_FLOAT_LE: out[index] = view.getFloat32(at, true); break
    }
  }
  return out
}

/** Floats (-1 to 1) as interleaved samples of `format` */
export function fromFloats(samples: Float32Array, format: number): Uint8Array {
  const size = bytesOf(format) ?? 2
  const out = new Uint8Array(samples.length * size)
  const view = new DataView(out.buffer)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!))
    const at = index * size
    switch (format) {
      case FORMAT_S8: view.setInt8(at, Math.round(sample < 0 ? sample * 128 : sample * 127)); break
      case FORMAT_U8: view.setUint8(at, Math.round(sample < 0 ? sample * 128 : sample * 127) + 128); break
      case FORMAT_S16_LE: view.setInt16(at, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true); break
      case FORMAT_S24_3LE: {
        const value = Math.round(sample < 0 ? sample * 8388608 : sample * 8388607)
        view.setUint8(at, value & 0xff); view.setUint8(at + 1, (value >> 8) & 0xff); view.setUint8(at + 2, (value >> 16) & 0xff)
        break
      }
      case FORMAT_S32_LE: view.setInt32(at, Math.round(sample < 0 ? sample * 2147483648 : sample * 2147483647), true); break
      case FORMAT_FLOAT_LE: view.setFloat32(at, sample, true); break
    }
  }
  return out
}

/**
 * `struct snd_pcm_info` (288 bytes: device, subdevice, stream and card numbers, the id, name and subdevice name, the class, and
 * how many subdevices there are and are free) for the card's one playback or capture device
 */
export function pcmInfoBytes(out: Uint8Array, playback: boolean, device = 0, open = false): Uint8Array {
  const view = new DataView(out.buffer, out.byteOffset)
  view.setUint32(0, device, true)
  view.setUint32(4, 0, true)
  view.setInt32(8, playback ? 0 : 1, true)
  view.setInt32(12, 0, true)
  text(out, 16, 64, 'Web Audio')
  text(out, 80, 80, playback ? 'Web Audio Output' : 'Web Audio Input')
  text(out, 160, 32, 'subdevice #0')
  view.setInt32(192, 1, true)
  view.setInt32(196, 0, true)
  view.setUint32(200, 1, true)
  view.setUint32(204, open ? 0 : 1, true)
  return out
}

const timespec = (view: DataView, at: number, milliseconds: number) => {
  putI64(view, at, Math.floor(milliseconds / 1000))
  view.setInt32(at + 8, Math.floor((milliseconds % 1000) * 1e6), true)
}

export class PcmStream implements DeviceSession {
  readonly info
  /** Woken whenever the state or a pointer changes, for `poll` */
  readonly queue = new WaitQueue()

  private readonly playback: boolean
  private state: State = PcmState.open
  private stream?: Stream
  private sw?: Sw
  private context?: AudioContext
  private gain?: GainNode
  private microphone?: { stream: MediaStream, source: MediaStreamAudioSourceNode, processor: ScriptProcessorNode }
  private unsubscribe?: () => void
  private closed = false
  /** The open file that has the stream (see `ioctl`) */
  private owner?: unknown

  /** Frames a program has written (playback) or read (capture), counted without wrapping */
  private appl = 0
  /** Frames captured since the stream began, counted without wrapping */
  private captured = 0
  /** The hardware pointer while the stream is not running */
  private frozen = 0
  private maxAvail = 0
  /** The audio clock's time at which frame 0 is heard */
  private origin = 0
  /** Playback written before the stream started, as one array of interleaved floats each */
  private held: Float32Array[] = []
  private readonly active = new Set<AudioBufferSourceNode>()
  /** Frames captured and not yet read, as interleaved floats */
  private recorded: Float32Array[] = []
  private recordedFrames = 0
  private triggered = performance.now()
  private waiters = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private tstamp = 0

  constructor(private readonly options: PcmOptions) {
    this.playback = options.direction === 'playback'
    this.info = { kind: this.playback ? 'alsa-playback' : 'alsa-capture', read: false, write: false }
  }

  get streamState() { return this.state }

  // --- the pointers ---

  private get boundary() { return this.sw?.boundary ?? BoundaryLimit }

  /** Frames the hardware has gone through: played, or captured */
  private hw(): number {
    const stream = this.stream
    if (!stream) return 0
    if (!this.playback) return this.captured
    if (this.state !== PcmState.running && this.state !== PcmState.draining) return this.frozen
    const context = this.context
    if (!context) return this.frozen
    return Math.max(0, Math.min(this.appl, Math.floor((context.currentTime - this.origin) * stream.rate)))
  }

  /** Frames a program may write (playback) or read (capture) now */
  private avail(): number {
    const stream = this.stream
    if (!stream) return 0
    return this.playback ? stream.bufferSize - (this.appl - this.hw()) : this.captured - this.appl
  }

  private notify() {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
    this.queue.wake_up()
  }

  /** Resolves when something changes, or after `WaitSlice` milliseconds (the clock moves without telling anyone) */
  private changed(): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve() }
      const timer = setTimeout(done, WaitSlice)
      this.waiters.add(done)
    })
  }

  /** Notices a stream that has run out of sound, or has played all it was given while draining */
  private refresh() {
    const stream = this.stream
    if (!stream || !this.sw) return
    if (this.playback) {
      if (this.state === PcmState.running || this.state === PcmState.draining) {
        const hw = this.hw()
        if (hw >= this.appl) {
          if (this.state === PcmState.draining) this.finish()
          else if (this.sw.stopThreshold <= stream.bufferSize) this.fail()
        }
      }
    } else if (this.state === PcmState.draining && this.recordedFrames === 0) {
      this.state = PcmState.setup
      this.notify()
    }
  }

  /** The stream ran dry or overflowed */
  private fail() {
    this.frozen = this.playback ? this.appl : this.captured
    this.stopSources()
    this.state = PcmState.xrun
    this.triggered = performance.now()
    this.notify()
  }

  /** A drain has played everything */
  private finish() {
    this.frozen = this.appl
    this.stopSources()
    this.state = PcmState.setup
    this.triggered = performance.now()
    this.notify()
  }

  private stopSources() {
    for (const source of this.active) { try { source.stop() } catch { /* already over */ } }
    this.active.clear()
    this.held = []
    clearTimeout(this.timer)
    const microphone = this.microphone
    this.microphone = undefined
    if (microphone) {
      microphone.processor.onaudioprocess = null
      try { microphone.source.disconnect() } catch { /* gone */ }
      try { microphone.processor.disconnect() } catch { /* gone */ }
      for (const track of microphone.stream.getTracks()) track.stop()
    }
  }

  // --- the browser's side ---

  private open(): AudioContext {
    const stream = this.stream
    if (!stream) throw withErrno('EBADFD')
    if (this.context) return this.context
    try {
      this.context = this.options.environment.createContext(stream.rate)
    } catch (error) {
      throw withErrno('EINVAL', error instanceof Error ? error.message : 'the browser cannot play at that rate')
    }
    if (this.playback) {
      this.gain = this.context.createGain()
      this.gain.gain.value = mixer.playbackGain
      this.gain.connect(this.context.destination)
      this.unsubscribe ??= mixer.onChange(() => { if (this.gain) this.gain.gain.value = mixer.playbackGain })
    }
    return this.context
  }

  private release() {
    this.stopSources()
    const context = this.context
    this.context = undefined
    this.gain = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    void context?.close().catch(() => {})
  }

  /** Plays `samples` (interleaved floats) so that its first frame is heard at frame `at` of the stream */
  private schedule(samples: Float32Array, at: number) {
    const stream = this.stream!, context = this.context!
    const frames = samples.length / stream.channels
    const buffer = context.createBuffer(stream.channels, frames, stream.rate)
    for (let channel = 0; channel < stream.channels; channel++) {
      const plane = new Float32Array(frames)
      for (let index = 0; index < frames; index++) plane[index] = samples[index * stream.channels + channel]!
      buffer.copyToChannel(plane, channel)
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain!)
    this.active.add(source)
    source.onended = () => { this.active.delete(source); this.notify() }
    source.start(Math.max(context.currentTime, this.origin + at / stream.rate))
  }

  private begin() {
    const stream = this.stream!
    const context = this.open()
    void context.resume().catch(() => {})
    this.state = PcmState.running
    this.triggered = performance.now()
    if (this.playback) {
      this.origin = context.currentTime + StartLead
      let at = 0
      for (const samples of this.held) { this.schedule(samples, at); at += samples.length / stream.channels }
      this.held = []
    }
    this.notify()
  }

  /** Starts the microphone (for a capture stream; a playback stream starts at once) */
  private async startCapture() {
    const stream = this.stream!
    const context = this.open()
    let media: MediaStream
    try {
      media = await this.options.environment.getUserMedia({ audio: { channelCount: stream.channels, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    } catch (error) {
      throw withErrno('EACCES', error instanceof Error ? error.message : 'the microphone was refused')
    }
    if (this.closed || this.state !== PcmState.prepared) { for (const track of media.getTracks()) track.stop(); return }
    const source = context.createMediaStreamSource(media)
    const processor = context.createScriptProcessor(2048, stream.channels, stream.channels)
    processor.onaudioprocess = event => this.record(event.inputBuffer)
    source.connect(processor)
    // a processor only runs while it is connected on to the destination; it writes nothing there
    processor.connect(context.destination)
    this.microphone = { stream: media, source, processor }
    void context.resume().catch(() => {})
    this.state = PcmState.running
    this.triggered = performance.now()
    this.notify()
  }

  private record(input: AudioBuffer) {
    const stream = this.stream
    if (!stream || (this.state !== PcmState.running && this.state !== PcmState.paused)) return
    if (this.state === PcmState.paused) return
    const frames = input.length
    const out = new Float32Array(frames * stream.channels)
    const gain = mixer.captureGain
    for (let channel = 0; channel < stream.channels; channel++) {
      const data = input.getChannelData(Math.min(channel, input.numberOfChannels - 1))
      for (let index = 0; index < frames; index++) out[index * stream.channels + channel] = data[index]! * gain
    }
    this.recorded.push(out)
    this.recordedFrames += frames
    this.captured += frames
    // a stream nobody reads fills its buffer, and then it is an xrun, or (with no stop threshold) loses its oldest sound
    if (this.captured - this.appl >= this.sw!.stopThreshold && this.sw!.stopThreshold <= stream.bufferSize) { this.fail(); return }
    while (this.recordedFrames > stream.bufferSize && this.recorded.length) {
      const dropped = this.recorded.shift()!
      this.recordedFrames -= dropped.length / stream.channels
      this.appl += dropped.length / stream.channels
    }
    this.maxAvail = Math.max(this.maxAvail, this.avail())
    this.notify()
  }

  // --- poll ---

  poll(): number {
    this.refresh()
    const ok = this.playback ? EPOLLOUT : EPOLLIN
    switch (this.state) {
      case PcmState.running: case PcmState.prepared: case PcmState.paused: {
        const wanted = this.sw?.availMin ?? 1
        if (this.avail() >= wanted) return ok
        this.arm(wanted)
        return 0
      }
      case PcmState.draining:
        if (this.playback) { this.arm(0); return 0 }
        return this.recordedFrames > 0 ? ok : 0
      default: return ok | EPOLLERR
    }
  }

  /** Wakes whoever polls when the clock will have made room for `wanted` frames */
  private arm(wanted: number) {
    clearTimeout(this.timer)
    const stream = this.stream
    if (!this.playback || !stream || (this.state !== PcmState.running && this.state !== PcmState.draining)) return
    const need = this.state === PcmState.draining ? this.appl - this.hw() : wanted - this.avail()
    this.timer = setTimeout(() => { this.refresh(); this.notify() }, Math.max(1, Math.ceil(need * 1000 / stream.rate) + 1))
  }

  // --- ioctl ---

  /** Answers `request`: the bytes of the program's structure, filled in, a count, or nothing */
  async ioctl(request: number, arg: unknown, nonblock = false, file?: unknown): Promise<Uint8Array | number> {
    if (this.closed) throw withErrno('ENODEV')
    // one subdevice, one user: the descriptor that first asked for something has the stream, and another one is told it is busy
    if (file !== undefined) {
      if (this.owner !== undefined && this.owner !== file) throw withErrno('EBUSY')
      this.owner = file
    }
    this.refresh()
    switch (request & 0xff) {
      case PVERSION: return this.putInt(ProtocolVersion)
      case USER_PVERSION: case TSTAMP: case TTSTAMP: return 0
      case INFO: return this.pcmInfo(argument(arg, 288))
      case HW_REFINE: return this.hwRefine(arg)
      case HW_PARAMS: return this.hwParams(arg)
      case HW_FREE: return this.hwFree()
      case SW_PARAMS: return this.swParams(arg)
      case STATUS: case STATUS_EXT: return this.status(arg)
      case DELAY: return this.delay()
      case HWSYNC: return 0
      case SYNC_PTR: return this.syncPtr(arg)
      case CHANNEL_INFO: throw withErrno('EINVAL')
      case PREPARE: return this.prepare()
      case RESET: return this.reset()
      case START: return await this.start()
      case DROP: return this.drop()
      case DRAIN: return await this.drain(nonblock)
      case PAUSE: return await this.pause(argument(arg, 4)[0] !== 0)
      case REWIND: case FORWARD: return this.noMove(arg)
      case RESUME: throw withErrno('ENOSYS')
      case XRUN: return this.forceXrun()
      case WRITEI_FRAMES: return await this.transmit(argument(arg, ((arg as ArrayLike<number> | undefined)?.length ?? 0)), nonblock)
      case READI_FRAMES: return await this.receive(argument(arg, ((arg as ArrayLike<number> | undefined)?.length ?? 0)), nonblock)
      case WRITEN_FRAMES: case READN_FRAMES: throw withErrno('ENOTTY')
      case LINK: throw withErrno('EINVAL')
      case UNLINK: throw withErrno('EINVAL')
      case FRAME_BYTES: {
        if (!this.stream) throw withErrno('EBADFD')
        return this.putInt(this.stream.frameBytes)
      }
      default: throw withErrno('ENOTTY')
    }
  }

  private putInt(value: number) {
    const out = new Uint8Array(4)
    new DataView(out.buffer).setInt32(0, value, true)
    return out
  }

  private pcmInfo(out: Uint8Array) {
    return pcmInfoBytes(out, this.playback, this.options.minor - (this.playback ? 16 : 24), this.state !== PcmState.disconnected)
  }

  private hwRefine(arg: unknown) {
    if (this.state === PcmState.disconnected) throw withErrno('ENODEV')
    if (this.state > PcmState.prepared) throw withErrno('EBADFD')
    const out = argument(arg, HwParamsSize)
    const refined = refine(parseHwParams(out))
    if (!refined) throw withErrno('EINVAL')
    return writeHwParams(refined, out)
  }

  private hwParams(arg: unknown) {
    if (this.state !== PcmState.open && this.state !== PcmState.setup && this.state !== PcmState.prepared) throw withErrno('EBADFD')
    const out = argument(arg, HwParamsSize)
    const refined = refine(parseHwParams(out))
    const chosen = refined && choose(refined)
    if (!chosen) throw withErrno('EINVAL')
    const changed = !this.stream || this.stream.rate !== chosen.stream.rate || this.stream.channels !== chosen.stream.channels
    this.stopSources()
    if (changed) this.release()
    this.stream = chosen.stream
    const buffer = chosen.stream.bufferSize
    // as Linux has it, for a 64 bit `long` (alsa-lib computes the same, and asks for thresholds up to it): the buffer doubled while it fits.
    // The result is the buffer times a power of two, which a number holds exactly.
    let whole = BigInt(buffer)
    const room = (1n << 63n) - 1n - BigInt(buffer)
    while (whole * 2n <= room) whole *= 2n
    const boundary = Number(whole)
    this.sw = {
      tstampMode: 0, periodStep: 1, sleepMin: 0, availMin: chosen.stream.periodSize, xferAlign: 1, startThreshold: 1,
      stopThreshold: buffer, silenceThreshold: 0, silenceSize: 0, boundary, tstampType: 0
    }
    this.appl = 0
    this.captured = 0
    this.frozen = 0
    this.recorded = []
    this.recordedFrames = 0
    this.state = PcmState.setup
    if (this.playback) this.open()
    this.notify()
    return writeHwParams(chosen.params, out)
  }

  private hwFree() {
    if (this.state !== PcmState.setup && this.state !== PcmState.prepared && this.state !== PcmState.open) throw withErrno('EBADFD')
    this.release()
    this.stream = undefined
    this.sw = undefined
    this.state = PcmState.open
    this.notify()
    return 0
  }

  private swParams(arg: unknown) {
    if (this.state === PcmState.open || this.state === PcmState.disconnected || !this.stream || !this.sw) throw withErrno('EBADFD')
    const out = argument(arg, 136)
    const view = new DataView(out.buffer)
    const sw: Sw = {
      tstampMode: view.getInt32(0, true), periodStep: view.getUint32(4, true), sleepMin: view.getUint32(8, true),
      availMin: u64(view, 16), xferAlign: u64(view, 24), startThreshold: u64(view, 32), stopThreshold: u64(view, 40),
      silenceThreshold: u64(view, 48), silenceSize: u64(view, 56), boundary: this.sw.boundary, tstampType: view.getUint32(76, true)
    }
    if (sw.tstampMode < 0 || sw.tstampMode > 1 || sw.tstampType > 2) throw withErrno('EINVAL')
    if (sw.availMin < 1 || sw.availMin > this.stream.bufferSize) throw withErrno('EINVAL')
    if (sw.startThreshold > sw.boundary || sw.stopThreshold > sw.boundary || sw.silenceThreshold > sw.boundary || sw.silenceSize > sw.boundary) throw withErrno('EINVAL')
    this.sw = sw
    putU64(view, 64, sw.boundary)
    this.notify()
    return out
  }

  private fillStatus(out: Uint8Array, at: number) {
    // struct snd_pcm_status { i32 state; pad; timespec trigger_tstamp, tstamp; u64 appl_ptr, hw_ptr; i64 delay; u64 avail, avail_max, overrange; u32 suspended_state; u32 audio_tstamp_data; timespec audio_tstamp, driver_tstamp; u32 audio_tstamp_accuracy; ... }
    const view = new DataView(out.buffer, out.byteOffset)
    const hw = this.hw()
    const avail = this.stream ? this.avail() : 0
    this.maxAvail = Math.max(this.maxAvail, avail)
    view.setInt32(at, this.state, true)
    timespec(view, at + 8, this.triggered)
    timespec(view, at + 24, performance.now())
    putU64(view, at + 40, this.appl % this.boundary)
    putU64(view, at + 48, hw % this.boundary)
    putI64(view, at + 56, this.playback ? this.appl - hw : hw - this.appl)
    putU64(view, at + 64, Math.max(0, avail))
    putU64(view, at + 72, this.maxAvail)
    putU64(view, at + 80, 0)
    view.setUint32(at + 88, 0, true)
  }

  private status(arg: unknown) {
    const out = argument(arg, 152)
    this.fillStatus(out, 0)
    return out
  }

  private delay() {
    const out = new Uint8Array(8)
    if (this.state === PcmState.open || this.state === PcmState.setup || !this.stream) throw withErrno('EBADFD')
    const hw = this.hw()
    putI64(new DataView(out.buffer), 0, this.playback ? this.appl - hw : hw - this.appl)
    return out
  }

  private syncPtr(arg: unknown) {
    // struct snd_pcm_sync_ptr { u32 flags; union { struct snd_pcm_mmap_status status; } s (at 8); union { struct snd_pcm_mmap_control control; } c (at 72); }
    const out = argument(arg, 136)
    const view = new DataView(out.buffer)
    const flags = view.getUint32(0, true)
    if (!(flags & SYNC_PTR_APPL) && this.stream) {
      // the program moves appl_ptr itself (a mapped buffer's commit); the stream takes it as long as it stays inside what the buffer allows
      const wanted = u64(view, 72)
      const moved = (wanted - (this.appl % this.boundary) + this.boundary) % this.boundary
      if (moved !== 0) {
        if (moved > this.stream.bufferSize && this.boundary - moved > this.stream.bufferSize) throw withErrno('EINVAL')
        this.appl += moved <= this.boundary / 2 ? moved : moved - this.boundary
      }
    }
    if (!(flags & SYNC_PTR_AVAIL_MIN) && this.sw && this.stream) {
      const availMin = u64(view, 80)
      if (availMin >= 1 && availMin <= this.stream.bufferSize) this.sw.availMin = availMin
    }
    view.setInt32(8, this.state, true)
    putU64(view, 16, this.hw() % this.boundary)
    timespec(view, 24, performance.now())
    view.setInt32(40, 0, true)
    putU64(view, 72, this.appl % this.boundary)
    putU64(view, 80, this.sw?.availMin ?? 1)
    return out
  }

  private prepare() {
    if (this.state === PcmState.open || this.state === PcmState.disconnected || !this.stream) throw withErrno('EBADFD')
    if (this.state === PcmState.running || this.state === PcmState.draining) throw withErrno('EBUSY')
    this.stopSources()
    this.appl = 0
    this.captured = 0
    this.frozen = 0
    this.maxAvail = 0
    this.recorded = []
    this.recordedFrames = 0
    this.state = PcmState.prepared
    this.triggered = performance.now()
    if (this.gain) this.gain.gain.value = mixer.playbackGain
    this.notify()
    return 0
  }

  private reset() {
    if (this.state === PcmState.open || this.state === PcmState.disconnected || !this.stream) throw withErrno('EBADFD')
    const hw = this.hw()
    if (this.playback) {
      for (const source of this.active) { try { source.stop() } catch { /* over */ } }
      this.active.clear()
      this.held = []
      this.appl = hw
    } else {
      this.recorded = []
      this.recordedFrames = 0
      this.appl = this.captured
    }
    this.notify()
    return 0
  }

  private async start() {
    if (this.state !== PcmState.prepared) throw withErrno('EBADFD')
    if (this.playback) this.begin()
    else await this.startCapture()
    return 0
  }

  private drop() {
    if (this.state === PcmState.open || this.state === PcmState.disconnected || this.state === PcmState.suspended) throw withErrno('EBADFD')
    this.frozen = this.hw()
    this.stopSources()
    this.state = PcmState.setup
    this.triggered = performance.now()
    this.notify()
    return 0
  }

  private async drain(nonblock: boolean) {
    if (!this.stream) throw withErrno('EBADFD')
    switch (this.state) {
      case PcmState.prepared:
        if (this.playback && this.appl > 0) this.begin()
        else { this.state = PcmState.setup; this.notify(); return 0 }
        break
      case PcmState.running: case PcmState.paused: break
      case PcmState.xrun: this.state = PcmState.setup; this.notify(); return 0
      case PcmState.draining: break
      case PcmState.setup: return 0
      default: throw withErrno('EBADFD')
    }
    if (!this.playback) {
      // what was captured stays to be read; the microphone is let go
      this.frozen = this.captured
      const left = this.recorded
      const frames = this.recordedFrames
      this.stopSources()
      this.recorded = left
      this.recordedFrames = frames
      this.state = frames > 0 ? PcmState.draining : PcmState.setup
      this.notify()
      return 0
    }
    if (this.state === PcmState.paused) { void this.context?.resume().catch(() => {}); this.state = PcmState.running }
    this.state = PcmState.draining
    this.notify()
    if (nonblock) throw withErrno('EAGAIN')
    while (this.state === PcmState.draining && !this.closed) {
      this.refresh()
      if (this.state !== PcmState.draining) break
      await this.changed()
    }
    if (this.closed) throw withErrno('ENODEV')
    return 0
  }

  private async pause(enable: boolean) {
    if (enable) {
      if (this.state !== PcmState.running) throw withErrno('EBADFD')
      this.frozen = this.hw()
      this.state = PcmState.paused
      await this.context?.suspend().catch(() => {})
    } else {
      if (this.state !== PcmState.paused) throw withErrno('EBADFD')
      void this.context?.resume().catch(() => {})
      if (this.playback && this.context && this.stream) this.origin = this.context.currentTime - this.frozen / this.stream.rate
      this.state = PcmState.running
    }
    this.notify()
    return 0
  }

  private noMove(arg: unknown) {
    if (this.state === PcmState.open || this.state === PcmState.disconnected) throw withErrno('EBADFD')
    const out = argument(arg, 8)
    putU64(new DataView(out.buffer), 0, 0)
    return out
  }

  private forceXrun() {
    if (this.state !== PcmState.running) throw withErrno('EBADFD')
    this.fail()
    return 0
  }

  // --- data ---

  /** `WRITEI_FRAMES`: `request` is the program's `struct snd_xferi` followed by its frames; the answer is the structure with `result` set */
  private async transmit(request: Uint8Array, nonblock: boolean): Promise<Uint8Array> {
    if (!this.playback) throw withErrno('EBADFD')
    const stream = this.stream
    if (!stream || !this.sw) throw withErrno('EBADFD')
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength)
    const frames = Math.min(u64(view, 16), Math.floor((request.length - XferHeader) / stream.frameBytes))
    const samples = toFloats(request.subarray(XferHeader, XferHeader + frames * stream.frameBytes), stream.format)
    let done = 0
    let failure: Error | undefined
    while (done < frames) {
      this.refresh()
      const state = this.state
      if (state === PcmState.xrun) { failure = withErrno('EPIPE'); break }
      if (state === PcmState.suspended) { failure = withErrno('ESTRPIPE'); break }
      if (state === PcmState.disconnected || this.closed) { failure = withErrno('ENODEV'); break }
      if (state !== PcmState.prepared && state !== PcmState.running && state !== PcmState.paused) { failure = withErrno('EBADFD'); break }
      const room = this.avail()
      if (room < 1) {
        if (nonblock) { failure = withErrno('EAGAIN'); break }
        this.arm(1)
        await this.changed()
        continue
      }
      const count = Math.min(room, frames - done)
      const chunk = samples.slice(done * stream.channels, (done + count) * stream.channels)
      if (state === PcmState.prepared) {
        this.held.push(chunk)
      } else {
        // a stream with no stop threshold that ran out of sound carries on from here
        if (this.hw() >= this.appl && state === PcmState.running && this.context) this.origin = this.context.currentTime + StartLead - this.appl / stream.rate
        this.schedule(chunk, this.appl)
      }
      this.appl += count
      done += count
      this.maxAvail = Math.max(this.maxAvail, this.avail())
      if (this.state === PcmState.prepared && this.appl >= this.sw.startThreshold) this.begin()
      this.notify()
    }
    const out = request.slice(0, XferHeader)
    const reply = new DataView(out.buffer)
    if (done === 0 && failure) throw failure
    putI64(reply, 0, done)
    return out
  }

  /** `READI_FRAMES`: `request` is the structure (and room after it for the frames, which the host adds); the answer is the structure followed by the frames */
  private async receive(request: Uint8Array, nonblock: boolean): Promise<Uint8Array> {
    if (this.playback) throw withErrno('EBADFD')
    const stream = this.stream
    if (!stream || !this.sw) throw withErrno('EBADFD')
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength)
    const frames = Math.min(u64(view, 16), 1 << 22)
    if (this.state === PcmState.prepared) await this.startCapture()
    const parts: Float32Array[] = []
    let done = 0
    let failure: Error | undefined
    while (done < frames) {
      this.refresh()
      const state = this.state
      if (state === PcmState.xrun) { failure = withErrno('EPIPE'); break }
      if (state === PcmState.suspended) { failure = withErrno('ESTRPIPE'); break }
      if (state === PcmState.disconnected || this.closed) { failure = withErrno('ENODEV'); break }
      if (state !== PcmState.running && state !== PcmState.paused && state !== PcmState.draining) { failure = withErrno('EBADFD'); break }
      if (this.recordedFrames < 1) {
        if (state === PcmState.draining) { this.state = PcmState.setup; this.notify(); failure = withErrno('EBADFD'); break }
        if (nonblock) { failure = withErrno('EAGAIN'); break }
        await this.changed()
        continue
      }
      let take = Math.min(this.recordedFrames, frames - done)
      done += take
      this.recordedFrames -= take
      this.appl += take
      while (take > 0) {
        const head = this.recorded[0]!
        const have = head.length / stream.channels
        if (have <= take) { parts.push(head); this.recorded.shift(); take -= have } else {
          parts.push(head.subarray(0, take * stream.channels))
          this.recorded[0] = head.subarray(take * stream.channels)
          take = 0
        }
      }
      this.notify()
    }
    const floats = new Float32Array(done * stream.channels)
    let at = 0
    for (const part of parts) { floats.set(part, at); at += part.length }
    const data = fromFloats(floats, stream.format)
    const out = new Uint8Array(XferHeader + data.length)
    out.set(request.subarray(0, XferHeader))
    out.set(data, XferHeader)
    const reply = new DataView(out.buffer)
    if (done === 0 && failure) throw failure
    putI64(reply, 0, done)
    return out
  }

  // --- the node going away ---

  /** The device has gone (the node was removed) or the last close: stops everything and wakes whoever waits */
  async close() {
    this.closed = true
    this.state = PcmState.disconnected
    this.release()
    this.notify()
  }
}
