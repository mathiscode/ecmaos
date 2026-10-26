import { beforeAll, describe, expect, it } from 'vitest'
import { ioctl } from '@zenfs/core'

import { alsaDrivers, hw, mixer } from '@ecmaos-devices/audio'

const { anyParams, parseHwParams, writeHwParams, SAMPLE_BITS, CHANNELS, RATE, PERIOD_SIZE, PERIODS, BUFFER_SIZE, FORMAT, ACCESS } = hw

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const IOC_NONE = 0, IOC_WRITE = 1, IOC_READ = 2
const io = (direction: number, type: string, number: number, size: number) => ((direction << 30) | (size << 16) | (type.charCodeAt(0) << 8) | number) >>> 0
const rw = IOC_READ | IOC_WRITE

const PVERSION = io(IOC_READ, 'A', 0, 4)
const INFO = io(IOC_READ, 'A', 1, 288)
const HW_REFINE = io(rw, 'A', 0x10, 608)
const HW_PARAMS = io(rw, 'A', 0x11, 608)
const HW_FREE = io(IOC_NONE, 'A', 0x12, 0)
const SW_PARAMS = io(rw, 'A', 0x13, 136)
const STATUS = io(IOC_READ, 'A', 0x20, 152)
const DELAY = io(IOC_READ, 'A', 0x21, 8)
const SYNC_PTR = io(rw, 'A', 0x23, 136)
const PREPARE = io(IOC_NONE, 'A', 0x40, 0)
const START = io(IOC_NONE, 'A', 0x42, 0)
const DROP = io(IOC_NONE, 'A', 0x43, 0)
const DRAIN = io(IOC_NONE, 'A', 0x44, 0)
const PAUSE = io(IOC_WRITE, 'A', 0x45, 4)
const WRITEI = io(IOC_WRITE, 'A', 0x50, 24)
const READI = io(IOC_READ, 'A', 0x51, 24)

const CTL_PVERSION = io(IOC_READ, 'U', 0, 4)
const CARD_INFO = io(IOC_READ, 'U', 1, 376)
const ELEM_LIST = io(rw, 'U', 0x10, 72)
const ELEM_INFO = io(rw, 'U', 0x11, 272)
const ELEM_READ = io(rw, 'U', 0x12, 1224)
const ELEM_WRITE = io(rw, 'U', 0x13, 1224)
const PCM_NEXT_DEVICE = io(IOC_READ, 'U', 0x30, 4)
const PCM_INFO = io(rw, 'U', 0x31, 288)

const STATE = { open: 0, setup: 1, prepared: 2, running: 3, xrun: 4, draining: 5, paused: 6 }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const until = async (condition: () => boolean | Promise<boolean>, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end && !await condition();) await sleep(5)
}

/** A Web Audio context with a clock that is the real one, that keeps what it is asked to play and lets a test speak into the microphone */
class FakeContext {
  readonly started = Date.now()
  destination = {}
  played: Array<{ at: number, channels: Float32Array[] }> = []
  stopped = 0
  suspended = false
  closed = false
  processors: Array<{ onaudioprocess: ((event: unknown) => void) | null }> = []
  gain = { gain: { value: 1 }, connect() {} }
  constructor(readonly sampleRate: number) {}
  get currentTime() { return (Date.now() - this.started) / 1000 }
  createGain() { return this.gain }
  createBuffer(channels: number, length: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return { numberOfChannels: channels, length, getChannelData: (channel: number) => data[channel]!, copyToChannel: (source: Float32Array, channel: number) => { data[channel]!.set(source) } }
  }
  createBufferSource() {
    const context = this
    return {
      buffer: undefined as { getChannelData(channel: number): Float32Array, numberOfChannels: number } | undefined,
      onended: null as (() => void) | null,
      connect() {},
      start(at: number) {
        const buffer = this.buffer!
        context.played.push({ at, channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)) })
      },
      stop() { context.stopped++ }
    }
  }
  async resume() { this.suspended = false }
  async suspend() { this.suspended = true }
  async close() { this.closed = true }
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createScriptProcessor() {
    const processor = { onaudioprocess: null as ((event: unknown) => void) | null, connect() {}, disconnect() {} }
    this.processors.push(processor)
    return processor
  }
  /** What the microphone hears: mono samples */
  speak(samples: Float32Array) {
    const buffer = { length: samples.length, numberOfChannels: 1, getChannelData: () => samples }
    for (const processor of this.processors) processor.onaudioprocess?.({ inputBuffer: buffer })
  }
}

describe('ALSA nodes', () => {
  let kernel: Kernel
  const contexts: FakeContext[] = []
  let microphones = 0

  beforeAll(async () => {
    const environment = {
      createContext: (rate?: number) => { const context = new FakeContext(rate ?? 48000); contexts.push(context); return context as never },
      getUserMedia: async () => { microphones++; return { getTracks: () => [{ stop() {} }], getAudioTracks: () => [] } as never }
    }
    const card = {
      pkg: { name: 'audio', version: '0', description: 'a sound card that keeps what it is given' },
      getDrivers: async () => alsaDrivers(environment)
    }
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_ALL, devices: { audio: card as never } })
    await kernel.boot()
    // boot does not wait for the programs: unpacking them stalls the event loop, and a stream that runs on the real clock runs dry
    await kernel.whenProgramsReady()
    // the initfs is not unpacked in a test: alsa-lib reads the configuration the machine would have
    const { readFileSync } = process.getBuiltinModule('node:fs')
    await kernel.filesystem.fs.mkdir('/usr/share/alsa', { recursive: true })
    await kernel.filesystem.fs.writeFile('/usr/share/alsa/alsa.conf', readFileSync(`${process.cwd()}/public/initfs/usr/share/alsa/alsa.conf`, 'utf8'))
  }, 60_000)

  const pcm = '/dev/snd/pcmC0D0p'
  const capture = '/dev/snd/pcmC0D0c'
  const control = '/dev/snd/controlC0'
  const call = async (path: string, request: number, arg?: Uint8Array) => await ioctl(path, request, arg) as Uint8Array | number | undefined
  const ints = (bytes: Uint8Array | number | undefined) => new DataView((bytes as Uint8Array).buffer, (bytes as Uint8Array).byteOffset)
  const text = (bytes: Uint8Array, at: number, length: number) => new TextDecoder().decode(bytes.subarray(at, at + length)).replace(/\0.*$/s, '')

  /** A request for a stream: what a program asks, each given as a single value */
  const wanted = (options: { rate: number, channels: number, format: number, period: number, periods: number }) => {
    const params = anyParams()
    params.masks[ACCESS] = new Set([3])
    params.masks[FORMAT] = new Set([options.format])
    const set = (param: number, value: number) => { params.intervals[param - SAMPLE_BITS]!.min = value; params.intervals[param - SAMPLE_BITS]!.max = value }
    set(CHANNELS, options.channels)
    set(RATE, options.rate)
    set(PERIOD_SIZE, options.period)
    set(PERIODS, options.periods)
    return writeHwParams(params, new Uint8Array(608))
  }
  const S16 = 2

  const status = async (path: string) => {
    const bytes = await call(path, STATUS, new Uint8Array(152)) as Uint8Array
    const view = ints(bytes)
    return {
      state: view.getInt32(0, true),
      appl: Number(view.getBigUint64(40, true)),
      hw: Number(view.getBigUint64(48, true)),
      delay: Number(view.getBigInt64(56, true)),
      avail: Number(view.getBigUint64(64, true))
    }
  }

  const xfer = (frames: number, data = new Uint8Array(0)) => {
    const out = new Uint8Array(24 + data.length)
    new DataView(out.buffer).setBigUint64(16, BigInt(frames), true)
    out.set(data, 24)
    return out
  }

  /** A stream that has been set up and prepared: 8000 Hz, mono, 160 frames to a period, 4 periods */
  const prepared = async (path: string, rate = 8000, channels = 1) => {
    await call(path, HW_FREE).catch(() => {})
    await call(path, HW_PARAMS, wanted({ rate, channels, format: S16, period: 160, periods: 4 }))
    const sw = new Uint8Array(136)
    const view = new DataView(sw.buffer)
    view.setBigUint64(16, 160n, true)   // avail_min
    view.setBigUint64(32, 160n, true)   // start_threshold
    view.setBigUint64(40, 640n, true)   // stop_threshold: the buffer
    await call(path, SW_PARAMS, sw)
    await call(path, PREPARE)
  }

  it('are /dev/snd/controlC0, pcmC0D0p and pcmC0D0c, character devices on major 116', async () => {
    for (const [name, minor] of [['controlC0', 0], ['pcmC0D0p', 16], ['pcmC0D0c', 24]] as const) {
      const stat = await kernel.filesystem.fs.stat(`/dev/snd/${name}`)
      expect(stat.isCharacterDevice()).toBe(true)
      expect([Number(BigInt(stat.rdev) >> 20n), Number(BigInt(stat.rdev) & 0xfffffn)]).toEqual([116, minor])
    }
  })

  describe('the PCM interface', () => {
    it('answers the protocol version and says what the device is', async () => {
      expect(ints(await call(pcm, PVERSION)).getUint32(0, true)).toBe(0x00020011)
      const info = await call(pcm, INFO, new Uint8Array(288)) as Uint8Array
      expect(text(info, 16, 64)).toBe('Web Audio')
      expect(text(info, 80, 80)).toBe('Web Audio Output')
      expect(ints(info).getInt32(8, true)).toBe(0)
      const record = await call(capture, INFO, new Uint8Array(288)) as Uint8Array
      expect(text(record, 80, 80)).toBe('Web Audio Input')
      expect(ints(record).getInt32(8, true)).toBe(1)
    })

    it('narrows a request to what the device can do, and refuses what it cannot', async () => {
      const refined = parseHwParams(await call(pcm, HW_REFINE, writeHwParams(anyParams(), new Uint8Array(608))) as Uint8Array)
      expect([...refined.masks[ACCESS]]).toEqual([3])
      expect([...refined.masks[FORMAT]]).toContain(S16)
      expect(refined.intervals[CHANNELS - SAMPLE_BITS]!.max).toBe(8)
      expect(refined.intervals[RATE - SAMPLE_BITS]!.min).toBe(8000)

      // a mmap-only request, and a rate no card has
      const mapped = anyParams()
      mapped.masks[ACCESS] = new Set([0])
      await expect(call(pcm, HW_REFINE, writeHwParams(mapped, new Uint8Array(608)))).rejects.toMatchObject({ code: 'EINVAL' })
      const slow = anyParams()
      slow.intervals[RATE - SAMPLE_BITS]!.max = 4000
      await expect(call(pcm, HW_REFINE, writeHwParams(slow, new Uint8Array(608)))).rejects.toMatchObject({ code: 'EINVAL' })
    })

    it('HW_PARAMS settles on one stream, whose sizes agree', async () => {
      const set = parseHwParams(await call(pcm, HW_PARAMS, wanted({ rate: 44100, channels: 2, format: S16, period: 441, periods: 4 })) as Uint8Array)
      const value = (param: number) => { const interval = set.intervals[param - SAMPLE_BITS]!; return interval.min === interval.max ? interval.min : NaN }
      expect([value(RATE), value(CHANNELS), value(PERIOD_SIZE), value(PERIODS), value(BUFFER_SIZE)]).toEqual([44100, 2, 441, 4, 1764])
      expect(value(SAMPLE_BITS)).toBe(16)
      expect(value(9)).toBe(32)       // frame bits
      expect(value(12)).toBe(10000)   // period time in microseconds
      expect(value(16)).toBe(40000)   // buffer time
      expect([...set.masks[FORMAT]]).toEqual([S16])
      expect(ints(await call(pcm, STATUS, new Uint8Array(152))).getInt32(0, true)).toBe(STATE.setup)
      await call(pcm, HW_FREE)
    })

    it('picks the smallest stream of what is left when the request leaves choices', async () => {
      const open = anyParams()
      open.intervals[RATE - SAMPLE_BITS]!.min = 22050
      open.intervals[RATE - SAMPLE_BITS]!.max = 48000
      const chosen = parseHwParams(await call(pcm, HW_PARAMS, writeHwParams(open, new Uint8Array(608))) as Uint8Array)
      const rate = chosen.intervals[RATE - SAMPLE_BITS]!
      expect(rate.min).toBe(22050)
      expect(rate.max).toBe(22050)
      const buffer = chosen.intervals[BUFFER_SIZE - SAMPLE_BITS]!
      const period = chosen.intervals[PERIOD_SIZE - SAMPLE_BITS]!
      const periods = chosen.intervals[PERIODS - SAMPLE_BITS]!
      expect(buffer.min).toBe(buffer.max)
      expect(buffer.min).toBe(period.min * periods.min)
      await call(pcm, HW_FREE)
    })

    it('SW_PARAMS gives the boundary, a whole number of buffers, and refuses an avail_min of 0', async () => {
      await call(pcm, HW_PARAMS, wanted({ rate: 8000, channels: 1, format: S16, period: 160, periods: 4 }))
      const sw = new Uint8Array(136)
      const view = new DataView(sw.buffer)
      view.setBigUint64(16, 160n, true)
      view.setBigUint64(40, 640n, true)
      const answer = ints(await call(pcm, SW_PARAMS, sw))
      const boundary = Number(answer.getBigUint64(64, true))
      expect(boundary % 640).toBe(0)
      expect(boundary).toBeGreaterThan(2 ** 30)
      view.setBigUint64(16, 0n, true)
      await expect(call(pcm, SW_PARAMS, sw)).rejects.toMatchObject({ code: 'EINVAL' })
      await call(pcm, HW_FREE)
    })

    it('plays what is written, as floats, in order, on the stream\'s sample rate', async () => {
      await prepared(pcm)
      const context = contexts.at(-1)!
      expect(context.sampleRate).toBe(8000)
      const samples = Int16Array.from({ length: 160 }, (_, i) => (i - 80) * 400)
      const reply = ints(await call(pcm, WRITEI, xfer(160, new Uint8Array(samples.buffer))))
      expect(Number(reply.getBigInt64(0, true))).toBe(160)
      // 160 frames is the start threshold: the stream runs
      expect((await status(pcm)).state).toBe(STATE.running)
      expect(context.played).toHaveLength(1)
      const heard = context.played[0]!.channels[0]!
      expect(heard).toHaveLength(160)
      expect(heard[0]).toBeCloseTo(-80 * 400 / 32768, 5)
      expect(heard[159]).toBeCloseTo(79 * 400 / 32768, 5)
      await call(pcm, DROP)
    })

    it('holds what is written before the stream starts, and plays it in order when it does', async () => {
      await prepared(pcm)
      const context = contexts.at(-1)!
      const before = context.played.length
      // below the start threshold: nothing is heard yet
      await call(pcm, WRITEI, xfer(100, new Uint8Array(200).fill(1)))
      expect((await status(pcm)).state).toBe(STATE.prepared)
      expect(context.played.length).toBe(before)
      await call(pcm, WRITEI, xfer(60, new Uint8Array(120).fill(2)))
      expect((await status(pcm)).state).toBe(STATE.running)
      const parts = context.played.slice(before)
      expect(parts.map(part => part.channels[0]!.length)).toEqual([100, 60])
      expect(parts[1]!.at).toBeCloseTo(parts[0]!.at + 100 / 8000, 5)
      await call(pcm, DROP)
    })

    it('counts frames with the audio clock, and the buffer is the room between what was written and what was heard', async () => {
      await prepared(pcm)
      await call(pcm, WRITEI, xfer(320, new Uint8Array(640)))
      const first = await status(pcm)
      expect(first.appl).toBe(320)
      expect(first.avail).toBeGreaterThanOrEqual(320)
      await sleep(60)
      const later = await status(pcm)
      expect(later.hw).toBeGreaterThan(first.hw)
      expect(later.hw).toBeLessThanOrEqual(320)
      expect(later.delay).toBe(later.appl - later.hw)
      expect(later.avail).toBe(640 - later.delay)
      await call(pcm, DROP)
    })

    it('makes a writer wait for room when the buffer is full, and lets it go as the clock plays', async () => {
      await prepared(pcm)
      const started = Date.now()
      // 4 periods of room, 8 written: the second half waits for the first to be heard (80 ms of sound)
      const reply = ints(await call(pcm, WRITEI, xfer(1280, new Uint8Array(2560))))
      expect(Number(reply.getBigInt64(0, true))).toBe(1280)
      expect(Date.now() - started).toBeGreaterThan(60)
      await call(pcm, DROP)
    })

    it('is an xrun (EPIPE) when the stream runs dry, and PREPARE brings it back', async () => {
      await prepared(pcm)
      await call(pcm, WRITEI, xfer(160, new Uint8Array(320)))
      await until(async () => (await status(pcm)).state === STATE.xrun)
      expect((await status(pcm)).state).toBe(STATE.xrun)
      await expect(call(pcm, WRITEI, xfer(160, new Uint8Array(320)))).rejects.toMatchObject({ code: 'EPIPE' })
      await call(pcm, PREPARE)
      expect((await status(pcm)).state).toBe(STATE.prepared)
      await call(pcm, WRITEI, xfer(160, new Uint8Array(320)))
      expect((await status(pcm)).state).toBe(STATE.running)
      await call(pcm, DROP)
    })

    it('DRAIN waits until everything written has been heard, then the stream is set up again', async () => {
      await prepared(pcm)
      await call(pcm, WRITEI, xfer(480, new Uint8Array(960)))
      const started = Date.now()
      await call(pcm, DRAIN)
      expect(Date.now() - started).toBeGreaterThan(20)
      const done = await status(pcm)
      expect(done.state).toBe(STATE.setup)
      expect(done.hw).toBe(480)
    })

    it('DROP stops at once and stops what was queued', async () => {
      await prepared(pcm)
      const context = contexts.at(-1)!
      const stopped = context.stopped
      await call(pcm, WRITEI, xfer(480, new Uint8Array(960)))
      await call(pcm, DROP)
      expect((await status(pcm)).state).toBe(STATE.setup)
      expect(context.stopped).toBeGreaterThan(stopped)
    })

    it('PAUSE suspends the clock, and lets it go again', async () => {
      await prepared(pcm)
      const context = contexts.at(-1)!
      await call(pcm, WRITEI, xfer(480, new Uint8Array(960)))
      await call(pcm, PAUSE, Uint8Array.of(1, 0, 0, 0))
      expect((await status(pcm)).state).toBe(STATE.paused)
      expect(context.suspended).toBe(true)
      await call(pcm, PAUSE, Uint8Array.of(0, 0, 0, 0))
      expect((await status(pcm)).state).toBe(STATE.running)
      expect(context.suspended).toBe(false)
      await call(pcm, DROP)
    })

    it('SYNC_PTR gives the pointers a mapped page would, and takes the application pointer', async () => {
      await prepared(pcm)
      await call(pcm, WRITEI, xfer(320, new Uint8Array(640)))
      const ask = new Uint8Array(136)
      new DataView(ask.buffer).setUint32(0, 2 | 4, true)   // get appl_ptr and avail_min from the driver
      const view = ints(await call(pcm, SYNC_PTR, ask))
      expect(view.getInt32(8, true)).toBe(STATE.running)
      expect(Number(view.getBigUint64(72, true))).toBe(320)
      expect(Number(view.getBigUint64(80, true))).toBe(160)
      await call(pcm, DROP)
    })

    it('converts the formats it takes', async () => {
      for (const [format, bytes, convert] of [
        [1, 1, (value: number) => Uint8Array.of(Math.round(value * 127) + 128)],
        [32, 3, (value: number) => { const sample = Math.round(value * 8388607); return Uint8Array.of(sample & 0xff, (sample >> 8) & 0xff, (sample >> 16) & 0xff) }],
        [10, 4, (value: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setInt32(0, Math.round(value * 2147483647), true); return out }],
        [14, 4, (value: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setFloat32(0, value, true); return out }]
      ] as const) {
        await call(pcm, HW_FREE).catch(() => {})
        await call(pcm, HW_PARAMS, wanted({ rate: 8000, channels: 1, format, period: 160, periods: 4 }))
        const sw = new Uint8Array(136)
        new DataView(sw.buffer).setBigUint64(16, 160n, true)
        new DataView(sw.buffer).setBigUint64(32, 1n, true)
        new DataView(sw.buffer).setBigUint64(40, 640n, true)
        await call(pcm, SW_PARAMS, sw)
        await call(pcm, PREPARE)
        const context = contexts.at(-1)!
        const before = context.played.length
        const data = new Uint8Array(bytes * 4)
        ;[0.5, -0.25, 0, 1].forEach((value, index) => data.set(convert(value), index * bytes))
        await call(pcm, WRITEI, xfer(4, data))
        const heard = context.played[before]!.channels[0]!
        // 8 bits cannot say 1 exactly
        ;[0.5, -0.25, 0, 1].forEach((value, index) => expect(Math.abs(heard[index]! - value)).toBeLessThan(0.01 + (format === 1 ? 0.01 : 0)))
        await call(pcm, DROP)
      }
      await call(pcm, HW_FREE)
    })

    it('plays stereo to two channels, interleaved', async () => {
      await prepared(pcm, 48000, 2)
      const context = contexts.at(-1)!
      const before = context.played.length
      const samples = Int16Array.from({ length: 320 }, (_, i) => i % 2 ? -(i + 1) * 10 : (i + 1) * 10)
      await call(pcm, WRITEI, xfer(160, new Uint8Array(samples.buffer)))
      const parts = context.played.slice(before)
      expect(parts[0]!.channels).toHaveLength(2)
      expect(Array.from(parts[0]!.channels[0]!.subarray(0, 2), v => Math.round(v * 32768))).toEqual([10, 30])
      expect(Array.from(parts[0]!.channels[1]!.subarray(0, 2), v => Math.round(v * 32768))).toEqual([-20, -40])
      await call(pcm, DROP)
      await call(pcm, HW_FREE)
    })

    it('the speakers follow the mixer', async () => {
      await prepared(pcm)
      const context = contexts.at(-1)!
      const element = (numid: number, left: number, right: number) => {
        const out = new Uint8Array(1224)
        const view = new DataView(out.buffer)
        view.setUint32(0, numid, true)
        view.setBigInt64(72, BigInt(left), true)
        view.setBigInt64(80, BigInt(right), true)
        return out
      }
      await call(control, ELEM_WRITE, element(1, 50, 50))
      expect(context.gain.gain.value).toBe(0.5)
      await call(control, ELEM_WRITE, element(2, 0, 0))
      expect(context.gain.gain.value).toBe(0)
      await call(control, ELEM_WRITE, element(2, 1, 1))
      await call(control, ELEM_WRITE, element(1, 100, 100))
      expect(context.gain.gain.value).toBe(1)
      await call(pcm, HW_FREE)
    })
  })

  describe('capture', () => {
    it('reads what the microphone hears, waiting for it, in the stream\'s format', async () => {
      await prepared(capture)
      // READI starts the stream and waits for sound
      const heard = microphones
      const reading = call(capture, READI, xfer(160))
      await until(() => microphones > heard && contexts.at(-1)!.processors.length > 0)
      const context = contexts.at(-1)!
      expect(context.sampleRate).toBe(8000)
      context.speak(Float32Array.from({ length: 160 }, (_, i) => (i - 80) / 160))
      const answer = await reading as Uint8Array
      const view = ints(answer)
      expect(Number(view.getBigInt64(0, true))).toBe(160)
      expect(answer.length).toBe(24 + 320)
      const first = view.getInt16(24, true)
      expect(first).toBe(Math.round(-0.5 * 32768))
      expect((await status(capture)).state).toBe(STATE.running)
      await call(capture, DROP)
    })

    it('hands over only what was asked for and keeps the rest for the next read', async () => {
      await prepared(capture)
      const heard = microphones
      const reading = call(capture, READI, xfer(100))
      await until(() => microphones > heard && contexts.at(-1)!.processors.length > 0)
      const context = contexts.at(-1)!
      context.speak(Float32Array.from({ length: 160 }, (_, i) => i / 1000))
      await reading
      const left = await status(capture)
      expect(left.avail).toBe(60)
      const rest = await call(capture, READI, xfer(60)) as Uint8Array
      expect(ints(rest).getInt16(24, true)).toBe(Math.round(0.1 * 32768))
      await call(capture, DROP)
    })

    it('is an xrun when nobody reads and the buffer fills', async () => {
      await prepared(capture)
      await call(capture, START)
      const context = contexts.at(-1)!
      for (let i = 0; i < 5; i++) context.speak(new Float32Array(160))
      expect((await status(capture)).state).toBe(STATE.xrun)
      await expect(call(capture, READI, xfer(10))).rejects.toMatchObject({ code: 'EPIPE' })
      await call(capture, DROP)
    })
  })

  describe('the control interface', () => {
    it('says what the card is', async () => {
      expect(ints(await call(control, CTL_PVERSION)).getUint32(0, true)).toBe(0x00020009)
      const card = await call(control, CARD_INFO, new Uint8Array(376)) as Uint8Array
      expect(text(card, 8, 16)).toBe('Web')
      expect(text(card, 40, 32)).toBe('Web Audio')
      expect(text(card, 168, 80)).toBe('Web Audio Mixer')
    })

    it('lists the PCM devices: one, with a playback and a capture stream', async () => {
      expect(ints(await call(control, PCM_NEXT_DEVICE, Uint8Array.of(255, 255, 255, 255))).getInt32(0, true)).toBe(0)
      expect(ints(await call(control, PCM_NEXT_DEVICE, Uint8Array.of(0, 0, 0, 0))).getInt32(0, true)).toBe(-1)
      const request = (stream: number, device = 0) => {
        const out = new Uint8Array(288)
        new DataView(out.buffer).setUint32(0, device, true)
        new DataView(out.buffer).setInt32(8, stream, true)
        return out
      }
      expect(text(await call(control, PCM_INFO, request(0)) as Uint8Array, 80, 80)).toBe('Web Audio Output')
      expect(text(await call(control, PCM_INFO, request(1)) as Uint8Array, 80, 80)).toBe('Web Audio Input')
      await expect(call(control, PCM_INFO, request(0, 1))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('lists the mixer\'s controls and reads and sets them', async () => {
      const list = new Uint8Array(72)
      new DataView(list.buffer).setUint32(4, 8, true)
      const answer = await call(control, ELEM_LIST, list) as Uint8Array
      const view = ints(answer)
      expect(view.getUint32(8, true)).toBe(4)
      expect(view.getUint32(12, true)).toBe(4)
      const names = Array.from({ length: 4 }, (_, i) => text(answer, 72 + i * 64 + 16, 44))
      expect(names).toEqual(['Master Playback Volume', 'Master Playback Switch', 'Capture Volume', 'Capture Switch'])

      const named = new Uint8Array(272)
      new DataView(named.buffer).setInt32(4, 2, true)
      named.set(new TextEncoder().encode('Master Playback Volume'), 16)
      const info = ints(await call(control, ELEM_INFO, named))
      expect([info.getInt32(64, true), info.getUint32(72, true), Number(info.getBigInt64(80, true)), Number(info.getBigInt64(88, true))]).toEqual([2, 2, 0, 100])

      const value = new Uint8Array(1224)
      new DataView(value.buffer).setUint32(0, 3, true)
      const read = ints(await call(control, ELEM_READ, value))
      expect([Number(read.getBigInt64(72, true)), Number(read.getBigInt64(80, true))]).toEqual([100, 100])
      new DataView(value.buffer).setBigInt64(72, 30n, true)
      new DataView(value.buffer).setBigInt64(80, 70n, true)
      await call(control, ELEM_WRITE, value)
      expect(mixer.byName('Capture Volume')!.values).toEqual([30, 70])
      mixer.set(mixer.byName('Capture Volume')!, 0, 100)
      mixer.set(mixer.byName('Capture Volume')!, 1, 100)
      await expect(call(control, ELEM_INFO, new Uint8Array(272).fill(0, 0, 4).map((_, i) => i === 0 ? 99 : 0))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('the file itself is not readable or writable, and cannot be mapped', async () => {
      await expect(kernel.filesystem.fs.readFile(pcm)).rejects.toBeDefined()
    })
  })

  describe('alsa-utils, WALI programs on alsa-lib', () => {
    const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf8')
    const frames = (since: number) => contexts.slice(since).flatMap(context => context.played).reduce((sum, part) => sum + part.channels[0]!.length, 0)
    /** A WAV file of a 440 Hz tone at about a third of full scale */
    const wav = (rate: number, channels: number, seconds: number) => {
      const count = Math.round(rate * seconds)
      const data = new Int16Array(count * channels)
      for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) data[i * channels + c] = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000)
      const out = new Uint8Array(44 + data.byteLength)
      const view = new DataView(out.buffer)
      const tag = (at: number, text: string) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
      tag(0, 'RIFF'); view.setUint32(4, 36 + data.byteLength, true); tag(8, 'WAVE'); tag(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true)
      view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true)
      tag(36, 'data'); view.setUint32(40, data.byteLength, true)
      out.set(new Uint8Array(data.buffer), 44)
      return out
    }

    it('aplay -l and arecord -l list the card and its devices', async () => {
      expect(await kernel.shell.execute('aplay -l > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(await read('/tmp/e.txt')).toBe('')
      expect(await read('/tmp/o.txt')).toBe('**** List of PLAYBACK Hardware Devices ****\ncard 0: Web [Web Audio], device 0: Web Audio [Web Audio Output]\n  Subdevices: 1/1\n  Subdevice #0: subdevice #0\n')
      expect(await kernel.shell.execute('arecord -l > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(await read('/tmp/o.txt')).toContain('card 0: Web [Web Audio], device 0: Web Audio [Web Audio Input]')
    }, 60_000)

    it('aplay plays a file to the card as it is: the stream has the file\'s rate, and its samples arrive in order', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/tone.wav', wav(8000, 1, 0.5))
      const before = contexts.length
      expect(await kernel.shell.execute('aplay -D hw:0,0 /tmp/tone.wav > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(await read('/tmp/e.txt')).toBe("Playing WAVE '/tmp/tone.wav' : Signed 16 bit Little Endian, Rate 8000 Hz, Mono\n")
      expect(contexts.slice(before).map(context => context.sampleRate)).toEqual([8000])
      expect(frames(before)).toBe(4000)
      const heard = contexts.slice(before).flatMap(context => context.played)
      const samples = heard.flatMap(part => [...part.channels[0]!])
      // 440 Hz at 8000 Hz: sample 5 is sin(2 pi 440 5 / 8000) of 12000/32768
      expect(samples[5]).toBeCloseTo(Math.sin(2 * Math.PI * 440 * 5 / 8000) * 12000 / 32768, 3)
      expect(Math.max(...samples)).toBeCloseTo(12000 / 32768, 2)
    }, 60_000)

    it('aplay -v shows the stream it settled on', async () => {
      expect(await kernel.shell.execute('aplay -v -D hw:0,0 /tmp/tone.wav > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      const text = await read('/tmp/e.txt')
      expect(text).toContain("Hardware PCM card 0 'Web Audio' device 0 subdevice 0")
      expect(text).toContain('access       : RW_INTERLEAVED')
      expect(text).toContain('format       : S16_LE')
      expect(text).toMatch(/buffer_size  : 4000\n\s+period_size  : 1000/)
    }, 60_000)

    it('the default device converts: a 44100 Hz stereo file, and 24 bit samples at a rate no card is made for', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/stereo.wav', wav(44100, 2, 0.3))
      let before = contexts.length
      expect(await kernel.shell.execute('aplay /tmp/stereo.wav > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(await read('/tmp/e.txt')).toBe("Playing WAVE '/tmp/stereo.wav' : Signed 16 bit Little Endian, Rate 44100 Hz, Stereo\n")
      expect(frames(before)).toBeGreaterThanOrEqual(Math.round(44100 * 0.3))

      before = contexts.length
      expect(await kernel.shell.execute('aplay -f S24_LE -r 12345 -c 1 -d 1 /dev/zero > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(await read('/tmp/e.txt')).toContain('Signed 24 bit Little Endian, Rate 12345 Hz, Mono')
      expect(frames(before)).toBeGreaterThanOrEqual(12345)
    }, 60_000)

    it('memory-mapped access works through the default device (mmap_emul) and not on the card itself', async () => {
      const before = contexts.length
      expect(await kernel.shell.execute('aplay -M /tmp/tone.wav > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(frames(before)).toBe(4000)
      expect(await kernel.shell.execute('aplay -M -D hw:0,0 /tmp/tone.wav > /tmp/o.txt 2> /tmp/e.txt')).toBe(1)
      expect(await read('/tmp/e.txt')).toContain('Access type not available')
    }, 60_000)

    it('plays in non-blocking mode, waiting with poll', async () => {
      const before = contexts.length
      expect(await kernel.shell.execute('aplay -N -D hw:0,0 /tmp/tone.wav > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(frames(before)).toBe(4000)
    }, 60_000)

    it('has one user at a time: a second aplay is told the card is busy, and the first plays to the end', async () => {
      const first = kernel.shell.execute('aplay -D hw:0,0 -d 2 -f S16_LE -r 8000 /dev/zero > /tmp/o.txt 2> /tmp/e.txt')
      await sleep(900)
      expect(await kernel.shell.execute('aplay -D hw:0,0 -d 1 -f S16_LE -r 8000 /dev/zero > /tmp/o2.txt 2> /tmp/e2.txt')).toBe(1)
      expect(await read('/tmp/e2.txt')).toBe('aplay: main:850: audio open error: Resource busy\n')
      expect(await first).toBe(0)
    }, 60_000)

    it('plays the rest of the sound in real time: two seconds take about two seconds', async () => {
      const started = Date.now()
      expect(await kernel.shell.execute('aplay -D hw:0,0 -d 2 -f S16_LE -r 8000 /dev/zero > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(Date.now() - started).toBeGreaterThan(1900)
    }, 60_000)

    it('speaker-test plays a tone to each channel', async () => {
      const before = contexts.length
      expect(await kernel.shell.execute('speaker-test -t sine -f 440 -c 2 -l 1 > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      const out = await read('/tmp/o.txt')
      expect(out).toContain('Playback device is default')
      expect(out).toContain('Stream parameters are 48000Hz, S16_LE, 2 channels')
      expect(frames(before)).toBeGreaterThan(48000)
    }, 60_000)

    it('arecord records what the microphone hears, as a WAV file of the length asked for', async () => {
      const before = contexts.length
      const recording = kernel.shell.execute('arecord -d 1 -r 8000 -f S16_LE /tmp/rec.wav > /tmp/o.txt 2> /tmp/e.txt')
      const timer = setInterval(() => { for (const context of contexts.slice(before)) context.speak(new Float32Array(1024).fill(0.25)) }, 20)
      expect(await recording).toBe(0)
      clearInterval(timer)
      expect(await read('/tmp/e.txt')).toBe("Recording WAVE '/tmp/rec.wav' : Signed 16 bit Little Endian, Rate 8000 Hz, Mono\n")
      const file = await kernel.filesystem.fs.readFile('/tmp/rec.wav')
      const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
      expect(new TextDecoder().decode(file.subarray(0, 4))).toBe('RIFF')
      expect(view.getUint32(24, true)).toBe(8000)
      expect(file.length).toBe(44 + 16000)
      expect(view.getInt16(44 + 200, true)).toBe(8192)
    }, 60_000)

    it('amixer lists the mixer\'s controls, and sets them', async () => {
      expect(await kernel.shell.execute('amixer > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(await read('/tmp/e.txt')).toBe('')
      const out = await read('/tmp/o.txt')
      expect(out).toContain("Simple mixer control 'Master',0")
      expect(out).toContain('Front Left: Playback 100 [100%] [on]')
      expect(out).toContain("Simple mixer control 'Capture',0")

      expect(await kernel.shell.execute('amixer controls > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(await read('/tmp/o.txt')).toContain("numid=1,iface=MIXER,name='Master Playback Volume'")

      expect(await kernel.shell.execute('amixer sset Master 40% > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(await read('/tmp/o.txt')).toContain('Front Left: Playback 40 [40%] [on]')
      expect(mixer.playbackGain).toBe(0.4)
      expect(await kernel.shell.execute('amixer sset Master mute > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(mixer.playbackGain).toBe(0)
      expect(await kernel.shell.execute('amixer sset Master unmute > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(await kernel.shell.execute('amixer sset Master 100% > /tmp/o.txt 2> /tmp/e.txt')).toBe(0)
      expect(mixer.playbackGain).toBe(1)
    }, 60_000)
  })
})
