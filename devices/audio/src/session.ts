import { Feed, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession } from '@ecmaos-devices/session'

/** Where the audio comes from and goes to; the browser's by default, replaceable so the sessions can be tried without a sound card */
export interface AudioEnvironment {
  createContext(sampleRate?: number): AudioContext
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
}

const browser = (): AudioEnvironment => ({
  createContext: sampleRate => new AudioContext(sampleRate === undefined ? {} : { sampleRate }),
  getUserMedia: async constraints => {
    const devices = (globalThis as unknown as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices
    if (!devices?.getUserMedia) throw new SessionError('ENODEV', 'this machine has no microphone access')
    return await devices.getUserMedia(constraints)
  }
})

export interface AudioSessionOptions {
  /** Samples per second; default 16000, from 8000 to 48000 */
  rate?: number
  /** Channels of the speakers, 1 or 2 (interleaved); default 1 */
  channels?: 1 | 2
  environment?: AudioEnvironment
}

const rateOf = (options: AudioSessionOptions) => {
  const rate = options.rate ?? 16000
  if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) throw new SessionError('EINVAL', 'the rate is 8000 to 48000 samples per second')
  return rate
}

/** Float samples (-1 to 1) as 16 bit little endian integers */
export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!))
    view.setInt16(index * 2, Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), true)
  }
  return out
}

/** 16 bit little endian integers as float samples; an odd trailing byte is ignored */
export function fromPcm16(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.length / 2)
  const out = new Float32Array(count)
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2)
  for (let index = 0; index < count; index++) out[index] = view.getInt16(index * 2, true) / 32768
  return out
}

/**
 * The microphone as a device session: mono signed 16 bit little endian samples at `rate`. Read only. The user has to allow
 * microphone access to the page. Control `info` gives the rate and the state of the stream.
 */
export async function openMicrophoneSession(options: AudioSessionOptions = {}): Promise<DeviceSession> {
  const rate = rateOf(options)
  const environment = options.environment ?? browser()
  let stream: MediaStream
  try {
    stream = await environment.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
  } catch (error) {
    throw error instanceof SessionError ? error : new SessionError('EACCES', error instanceof Error ? error.message : 'the microphone was refused')
  }
  const context = environment.createContext(rate)
  const source = context.createMediaStreamSource(stream)
  // A microphone goes on whether or not anyone reads: the oldest sound is dropped past a few seconds
  const feed = new Feed(64)
  const processor = context.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = event => feed.push(toPcm16(event.inputBuffer.getChannelData(0)))
  source.connect(processor)
  // A processor only runs while it is connected on to the destination; it writes nothing there
  processor.connect(context.destination)
  const stopped = () => feed.end()
  for (const track of stream.getAudioTracks()) track.addEventListener('ended', stopped)
  return {
    info: { kind: 'audio-in', read: true, write: false, rate, channels: 1, format: 's16le' },
    read: () => feed.next(),
    async control(op) {
      if (op === 'info') return { rate: context.sampleRate, channels: 1, format: 's16le', state: context.state }
      throw new SessionError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
    },
    async close() {
      processor.onaudioprocess = null
      source.disconnect()
      processor.disconnect()
      for (const track of stream.getTracks()) track.stop()
      feed.end()
      await context.close().catch(() => {})
    }
  }
}

/** How much sound may be queued ahead of what is playing before a write waits, in seconds */
const MaxAhead = 1

/**
 * The speakers as a device session: mono signed 16 bit little endian samples at `rate`, played as they arrive. Write only. A
 * write waits while more than a second of sound is already queued, so a sender cannot outrun the speakers. Control `volume`
 * sets the level from 0 to 1.
 */
export async function openSpeakerSession(options: AudioSessionOptions = {}): Promise<DeviceSession> {
  const rate = rateOf(options)
  const channels = options.channels ?? 1
  const environment = options.environment ?? browser()
  const context = environment.createContext(rate)
  const gain = context.createGain()
  gain.connect(context.destination)
  let playAt = 0
  let carry: Uint8Array = new Uint8Array(0)
  let closed = false
  await context.resume().catch(() => {})
  return {
    info: { kind: 'audio-out', read: false, write: true, rate, channels, format: 's16le' },
    async write(data) {
      if (closed) throw new SessionError('ENODEV', 'the speakers are closed')
      const joined = new Uint8Array(carry.length + data.length)
      joined.set(carry)
      joined.set(data, carry.length)
      const frame = 2 * channels
      const whole = joined.length - (joined.length % frame)
      carry = joined.slice(whole)
      if (whole === 0) return
      const samples = fromPcm16(joined.subarray(0, whole))
      const frames = samples.length / channels
      while (!closed && playAt - context.currentTime > MaxAhead) await new Promise(resolve => setTimeout(resolve, 20))
      if (closed) return
      const buffer = context.createBuffer(channels, frames, rate)
      for (let channel = 0; channel < channels; channel++) {
        const plane = new Float32Array(frames)
        for (let index = 0; index < frames; index++) plane[index] = samples[index * channels + channel]!
        buffer.copyToChannel(plane, channel)
      }
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(gain)
      playAt = Math.max(playAt, context.currentTime)
      node.start(playAt)
      playAt += frames / rate
    },
    async control(op, args) {
      if (op === 'volume') {
        const level = args[0]
        if (typeof level !== 'number' || !(level >= 0 && level <= 1)) throw new SessionError('EINVAL', 'the volume is a number from 0 to 1')
        gain.gain.value = level
        return null
      }
      if (op === 'info') return { rate: context.sampleRate, channels, format: 's16le', volume: gain.gain.value, state: context.state }
      throw new SessionError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
    },
    async close() {
      closed = true
      await context.close().catch(() => {})
    }
  }
}

/** The most an encoded file may be before the player refuses more, in bytes */
const MaxFile = 64 * 1024 * 1024

export interface PlayerOptions {
  environment?: AudioEnvironment
  /** Called when the file that was written could not be decoded */
  onError?: (error: Error) => void
}

/**
 * An audio player for whole files (WAV, MP3, Ogg, anything the browser decodes), as `/dev/audio` is: what is written is
 * collected, and when the last writer closes the file it is decoded and played. Write only; control `volume` sets the level
 * from 0 to 1 and `info` the state.
 */
export async function openPlayerSession(options: PlayerOptions = {}): Promise<DeviceSession> {
  const environment = options.environment ?? browser()
  const parts: Uint8Array[] = []
  let size = 0
  let volume = 1
  return {
    info: { kind: 'audio-file', read: false, write: true },
    async write(data) {
      if (size + data.length > MaxFile) throw new SessionError('EFBIG', 'the audio file is too large')
      parts.push(data)
      size += data.length
    },
    async control(op, args) {
      if (op === 'volume') {
        const level = args[0]
        if (typeof level !== 'number' || !(level >= 0 && level <= 1)) throw new SessionError('EINVAL', 'the volume is a number from 0 to 1')
        volume = level
        return null
      }
      if (op === 'info') return { volume, bytes: size }
      throw new SessionError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
    },
    async close() {
      if (!size) return
      const bytes = new Uint8Array(size)
      let at = 0
      for (const part of parts) { bytes.set(part, at); at += part.length }
      const context = environment.createContext()
      try {
        const decoded = await context.decodeAudioData(bytes.buffer as ArrayBuffer)
        const gain = context.createGain()
        gain.gain.value = volume
        gain.connect(context.destination)
        const node = context.createBufferSource()
        node.buffer = decoded
        node.connect(gain)
        node.onended = () => { void context.close().catch(() => {}) }
        await context.resume().catch(() => {})
        node.start()
      } catch (error) {
        void context.close().catch(() => {})
        options.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
}
