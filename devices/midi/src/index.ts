import { Class } from '@zenfs/linux'
import { controlOperations, sessionOperations } from '@ecmaos-devices/session'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

import { openMidiSession } from './session.js'

export { openMidiSession, splitMessages, MidiError } from './session.js'
export type { MidiDeviceSession, MidiSessionOptions } from './session.js'

export const pkg = {
  name: 'midi',
  version: '0.1.0',
  description: 'MIDI device driver'
}

async function getMIDIAccess() {
  if (!navigator.requestMIDIAccess) {
    throw new Error('Web MIDI API not available')
  }
  return navigator.requestMIDIAccess()
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal } = options
  const usage = `
Usage: /dev/midi <command>

Commands:
  list                List all MIDI devices
  request             Request permission to access MIDI devices
  connect <id>        Connect to a specific MIDI device by ID
  disconnect <id>     Disconnect from a specific MIDI device
  --help             Show this help message
`

  if (!navigator.requestMIDIAccess) {
    terminal.writeln('Web MIDI API not available')
    return 1
  }

  if (!args.length || args[0] === '--help') {
    terminal.writeln(usage)
    return 0
  }

  try {
    switch (args[0]) {
      case 'list': {
        const midiAccess = await getMIDIAccess()
        const inputs = Array.from(midiAccess.inputs.values())
        const outputs = Array.from(midiAccess.outputs.values())

        if (!inputs.length && !outputs.length) {
          terminal.writeln('No MIDI devices found')
          return 0
        }

        if (inputs.length) {
          terminal.writeln('\nMIDI Inputs:')
          for (const input of inputs) {
            terminal.writeln(`  ${input.name || 'Unknown Device'} (${input.id})`)
            terminal.writeln(`    Manufacturer: ${input.manufacturer || 'Unknown'}`)
            terminal.writeln(`    State: ${input.state}\n`)
          }
        }

        if (outputs.length) {
          terminal.writeln('\nMIDI Outputs:')
          for (const output of outputs) {
            terminal.writeln(`  ${output.name || 'Unknown Device'} (${output.id})`)
            terminal.writeln(`    Manufacturer: ${output.manufacturer || 'Unknown'}`)
            terminal.writeln(`    State: ${output.state}\n`) 
          }
        }
        break
      }

      case 'request': {
        try {
          const midiAccess = await getMIDIAccess()
          terminal.writeln('MIDI access granted')
          terminal.writeln(`Sysex: ${midiAccess.sysexEnabled ? 'Enabled' : 'Disabled'}`)
        } catch (err) {
          terminal.writeln('Failed to get MIDI access')
          throw err
        }
        break
      }

      case 'connect': {
        if (!args[1]) {
          terminal.writeln('Please specify a device ID')
          return 1
        }

        const midiAccess = await getMIDIAccess()
        const device = midiAccess.inputs.get(args[1]) || midiAccess.outputs.get(args[1])
        
        if (!device) {
          terminal.writeln(`No device found with ID ${args[1]}`)
          return 1
        }

        if (device.state === 'connected') {
          terminal.writeln(`Device ${device.name} is already connected`)
        } else {
          device.open()
          terminal.writeln(`Connected to ${device.name}`)
        }
        break
      }

      case 'disconnect': {
        if (!args[1]) {
          terminal.writeln('Please specify a device ID')
          return 1
        }

        const midiAccess = await getMIDIAccess()
        const device = midiAccess.inputs.get(args[1]) || midiAccess.outputs.get(args[1])
        
        if (!device) {
          terminal.writeln(`No device found with ID ${args[1]}`)
          return 1
        }

        if (device.state === 'disconnected') {
          terminal.writeln(`Device ${device.name} is already disconnected`)
        } else {
          device.close()
          terminal.writeln(`Disconnected from ${device.name}`)
        }
        break
      }

      default:
        terminal.writeln(`Unknown command: ${args[0]}`)
        terminal.writeln(usage)
        return 1
    }

    return 0
  } catch (error) {
    terminal.writeln(`Error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** `/sys/class/midi` */
const midi_class = new Class('midi')

/** The ports a `midiN` node stands for: the Nth input and the Nth output */
export async function getDrivers(ctx: KernelContext): Promise<KernelCharDevice[]> {
  const drivers: KernelCharDevice[] = [{
    name: 'midi',
    major: 35,
    minor: 0,
    class: midi_class,
    ops: controlOperations
  }]

  // Ports are only listed once the user has allowed MIDI (`/dev/midi request`); asking here would raise a prompt at boot
  if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess || !navigator.permissions) return drivers
  try {
    const permission = await navigator.permissions.query({ name: 'midi' as PermissionName })
    if (permission.state !== 'granted') return drivers
    const access = await navigator.requestMIDIAccess()
    const count = Math.max(access.inputs.size, access.outputs.size)
    const ops = sessionOperations({
      async open(minor) {
        const live = await navigator.requestMIDIAccess()
        const index = minor - 1
        return await openMidiSession(live as unknown as Parameters<typeof openMidiSession>[0], {
          ...(index < live.inputs.size ? { input: index } : {}),
          ...(index < live.outputs.size ? { output: index } : {})
        })
      }
    })
    for (let index = 0; index < count; index++) drivers.push({ name: `midi${index}`, major: 35, minor: index + 1, class: midi_class, ops })
  } catch (error) {
    ctx.log.warn(`midi: cannot list ports: ${error instanceof Error ? error.message : String(error)}`)
  }
  return drivers
}
