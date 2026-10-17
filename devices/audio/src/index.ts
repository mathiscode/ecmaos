import { Class } from '@zenfs/linux'
import { sessionOperations } from '@ecmaos-devices/session'
import type { Kernel, KernelCharDevice, KernelContext, KernelDeviceCLIOptions, Shell } from '@ecmaos/types'

import { openMicrophoneSession, openPlayerSession, openSpeakerSession } from './session.js'

export { openMicrophoneSession, openPlayerSession, openSpeakerSession, toPcm16, fromPcm16 } from './session.js'
export type { AudioEnvironment, AudioSessionOptions, PlayerOptions } from './session.js'

export const pkg = {
  name: 'audio',
  version: '0.1.0',
  description: 'Web Audio API device driver'
}

export async function cli(options: KernelDeviceCLIOptions) {
  options.kernel.log.debug(`${pkg.name} CLI`, options.args)

  const usage = `
Usage: audio <command>

Commands:
  test    Play a test sequence of beeps
  --help  Show this help message
`

  if (!options.args.length || options.args[0] === '--help') {
    options.terminal.writeln(usage)
    return 0
  }

  switch (options.args[0]) {
    case 'test':
      await test(options.kernel, options.shell)
      break
    default:
      options.terminal.writeln(`Unknown command: ${options.args[0]}`)
      options.terminal.writeln(usage)
      return 1
  }

  return 0
}

async function test(kernel: Kernel, shell: Shell) {
  const sampleRate = 44100
  const noteLength = 0.25  // 250ms for regular notes
  const shortNoteLength = 0.125  // 125ms for shorter notes
  const gap = 0.05  // 50ms gap between notes
  const finalGap = 0.3  // Longer gap before last two notes

  // Musical note frequencies (in Hz) for "Shave and a Haircut"
  const notes = [
    783.99,  // G5
    523.25,  // C5
    523.25,  // C5
    659.25,  // E5
    587.33,  // D5
    0,       // Rest
    698.46,  // F5
    783.99   // G5
  ]
  
  const durations = [
    noteLength,
    shortNoteLength,
    shortNoteLength,
    noteLength,
    noteLength,
    finalGap,
    noteLength,
    noteLength
  ]

  // Calculate total samples needed
  const totalSamples = Math.floor(sampleRate * 
    (durations.reduce((a, b) => a + b, 0) + (gap * (notes.length - 1))))

  // Create WAV header (44 bytes)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  
  // "RIFF" chunk descriptor
  view.setUint32(0, 0x52494646, false) // "RIFF"
  view.setUint32(4, 36 + totalSamples * 2, true) // File size - 8
  view.setUint32(8, 0x57415645, false) // "WAVE"
  
  // "fmt " sub-chunk
  view.setUint32(12, 0x666D7420, false) // "fmt "
  view.setUint32(16, 16, true) // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true) // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true) // NumChannels (1 for mono)
  view.setUint32(24, sampleRate, true) // SampleRate
  view.setUint32(28, sampleRate * 2, true) // ByteRate
  view.setUint16(32, 2, true) // BlockAlign
  view.setUint16(34, 16, true) // BitsPerSample
  
  // "data" sub-chunk
  view.setUint32(36, 0x64617461, false) // "data"
  view.setUint32(40, totalSamples * 2, true) // Subchunk2Size

  // Create audio data
  const audioData = new ArrayBuffer(totalSamples * 2)
  const audioView = new DataView(audioData)

  // Generate audio data
  let offset = 0
  for (let i = 0; i < notes.length; i++) {
    const freq = notes[i]
    const samples = Math.floor(sampleRate * (durations[i] || 0))
    
    // Generate note or rest
    for (let j = 0; j < samples; j++) {
      const t = j / sampleRate
      const sample = freq === 0 ? 0 : Math.sin(2 * Math.PI * (freq || 0) * t) * 0x7FFF
      audioView.setInt16(offset * 2, sample, true)
      offset++
    }
    
    // Add gap after each note except the last
    if (i < notes.length - 1) {
      const gapSamples = Math.floor(sampleRate * gap)
      for (let j = 0; j < gapSamples; j++) {
        audioView.setInt16(offset * 2, 0, true)
        offset++
      }
    }
  }

  // Combine header and audio data
  const finalBuffer = new Uint8Array(header.byteLength + audioData.byteLength)
  finalBuffer.set(new Uint8Array(header), 0)
  finalBuffer.set(new Uint8Array(audioData), header.byteLength)

  try {
    kernel.terminal.writeln('Playing test beeps...')
    const fd = await shell.context.fs.promises.open('/dev/audio', 'w', 0o666)
    await fd.write(finalBuffer)
    await fd.close()
  } catch (error) {
    kernel.terminal.writeln(`Error playing audio: ${error}`)
    return 1
  }

  return 0
}

/** `/sys/class/audio` */
const audio_class = new Class('audio')

// Linux's sound majors: 14 minor 3 is /dev/dsp (mono, 16000 Hz), 19 is /dev/dsp1 (stereo, 48000 Hz; what SDL plays to), 4 is /dev/audio, 5 is /dev/dspin (the microphone, as this system names it).
// Each node has its own operations, so no minor number decides what a node is.
export async function getDrivers(ctx: KernelContext): Promise<KernelCharDevice[]> {
  const player = sessionOperations({ open: async () => await openPlayerSession({ onError: error => ctx.log.error(`audio: cannot play the file: ${error.message}`) }) })
  const speakers = sessionOperations({ open: async () => await openSpeakerSession(), onError: error => ctx.log.warn(`dsp: ${error.message}`) })
  const speakers48 = sessionOperations({ open: async () => await openSpeakerSession({ rate: 48000, channels: 2 }), onError: error => ctx.log.warn(`dsp1: ${error.message}`) })
  const microphone = sessionOperations({ open: async () => await openMicrophoneSession(), onError: error => ctx.log.warn(`dspin: ${error.message}`) })
  return [
    { name: 'audio', major: 14, minor: 4, class: audio_class, ops: player },
    { name: 'dsp', major: 14, minor: 3, class: audio_class, ops: speakers },
    { name: 'dsp1', major: 14, minor: 19, class: audio_class, ops: speakers48 },
    { name: 'dspin', major: 14, minor: 5, class: audio_class, ops: microphone }
  ]
}
