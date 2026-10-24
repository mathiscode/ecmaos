/**
 * The card's mixer: what `amixer` and `alsamixer` see as the controls of `/dev/snd/controlC0`. There are four, a volume (0 to 100)
 * and a switch for the speakers and for the microphone, each with a left and a right value. They are the machine's, not a
 * stream's: a stream asks for the gain when it starts and again whenever a control changes.
 */

export const VolumeMax = 100

export interface MixerControl {
  numid: number
  name: string
  type: 'integer' | 'boolean'
  /** Left and right */
  values: [number, number]
}

const controls: MixerControl[] = [
  { numid: 1, name: 'Master Playback Volume', type: 'integer', values: [VolumeMax, VolumeMax] },
  { numid: 2, name: 'Master Playback Switch', type: 'boolean', values: [1, 1] },
  { numid: 3, name: 'Capture Volume', type: 'integer', values: [VolumeMax, VolumeMax] },
  { numid: 4, name: 'Capture Switch', type: 'boolean', values: [1, 1] }
]

const listeners = new Set<() => void>()

export const mixer = {
  controls: controls as ReadonlyArray<MixerControl>,
  find: (numid: number) => controls.find(control => control.numid === numid),
  byName: (name: string) => controls.find(control => control.name === name),
  /** Sets one value and tells the streams */
  set(control: MixerControl, index: 0 | 1, value: number): boolean {
    const clamped = control.type === 'boolean' ? (value ? 1 : 0) : Math.max(0, Math.min(VolumeMax, Math.round(value)))
    if (control.values[index] === clamped) return false
    control.values[index] = clamped
    for (const listener of listeners) listener()
    return true
  },
  /** The gain (0 to 1) of the speakers: the volume where the switch is on, else silence */
  get playbackGain() { return level(controls[0]!, controls[1]!) },
  /** The gain of the microphone */
  get captureGain() { return level(controls[2]!, controls[3]!) },
  onChange(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
}

function level(volume: MixerControl, toggle: MixerControl): number {
  const on = toggle.values[0] || toggle.values[1]
  return on ? (volume.values[0] + volume.values[1]) / (2 * VolumeMax) : 0
}
