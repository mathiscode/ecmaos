import type { DeviceDriver } from '@zenfs/core'
import type { KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

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

export async function getDrivers(ctx: KernelContext): Promise<DeviceDriver[]> {
  const drivers: DeviceDriver[] = [{
    name: 'midi',
    init: () => ({
      major: 35,
      minor: 0,
      data: { kernelId: ctx.id }
    }),
    read: () => 0,
    write: () => 0
  }]

  return drivers
}
