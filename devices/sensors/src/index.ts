/// <reference types="w3c-generic-sensor" />

import ansi from 'ansi-escape-sequences'
import { Class } from '@zenfs/linux'
import { controlOperations, sessionOperations } from '@ecmaos-devices/session'
import type { DeviceSession } from '@ecmaos-devices/session'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

import { openSensorSession, SensorKinds } from './session.js'

export { openSensorSession, SensorKinds } from './session.js'
export type { SensorSessionOptions } from './session.js'

export const pkg = {
  name: 'sensors',
  version: '0.1.0',
  description: 'Device sensors driver'
}

const kinds = Object.keys(SensorKinds)
const available = (kind: string) => SensorKinds[kind]!.cls in globalThis

const decoder = new TextDecoder()
const watches = new Map<number, DeviceSession>()
let watchCounter = 0

/** One reading, from the JSON line a sensor session gives */
function describe(kind: string, line: string): string {
  const reading = JSON.parse(line) as Record<string, number | number[] | null>
  const num = (value: unknown, digits: number) => typeof value === 'number' ? value.toFixed(digits) : 'N/A'
  const lines = [`${ansi.style.bold}${kind} reading:${ansi.style.reset}`, `  Time: ${ansi.style.cyan}${new Date(Number(reading['t'])).toISOString()}${ansi.style.reset}`]
  for (const field of SensorKinds[kind]!.fields) {
    const value = reading[field]
    if (Array.isArray(value)) value.forEach((part, index) => lines.push(`  ${field}[${index}]: ${ansi.style.cyan}${num(part, 3)}${ansi.style.reset}`))
    else lines.push(`  ${field}: ${ansi.style.cyan}${num(value, 2)}${ansi.style.reset}`)
  }
  return lines.join('\n')
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal } = options

  const usage = `
Usage: /dev/sensors <command>

Commands:
  list               List available sensors
  read <sensor>      Read current sensor values
  watch <sensor>     Start watching sensor changes
  unwatch <id>       Stop watching sensor changes
  --help             Show this help message

Each available sensor is also a file, /dev/sensor-<name>, that reads one JSON line per reading.
`

  if (!args.length || args[0] === '--help') {
    terminal.writeln(usage)
    return 0
  }

  const sensorArg = () => {
    const kind = args[1]
    if (!kind) { terminal.writeln('Please specify a sensor'); return undefined }
    if (!SensorKinds[kind]) {
      terminal.writeln(`Invalid sensor type: ${kind}`)
      terminal.writeln(`Available sensors: ${kinds.join(', ')}`)
      return undefined
    }
    return kind
  }

  try {
    switch (args[0]) {
      case 'list':
        terminal.writeln(`${ansi.style.bold}Available Sensors:${ansi.style.reset}`)
        kinds.filter(available).forEach(kind => terminal.writeln(`  - ${kind}`))
        break

      case 'read': {
        const kind = sensorArg()
        if (!kind) return 1
        const session = await openSensorSession(kind)
        try {
          const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5000))
          const chunk = await Promise.race([session.read!(), timeout])
          terminal.writeln(chunk ? describe(kind, decoder.decode(chunk)) : 'Sensor reading timed out')
        } finally {
          await session.close()
        }
        break
      }

      case 'watch': {
        const kind = sensorArg()
        if (!kind) return 1
        const session = await openSensorSession(kind)
        const id = ++watchCounter
        watches.set(id, session)
        void (async () => {
          for (;;) {
            const chunk = await session.read!()
            if (!chunk) break
            terminal.writeln(describe(kind, decoder.decode(chunk)))
          }
          watches.delete(id)
        })()
        terminal.writeln(`Started watching ${kind} (ID: ${id})`)
        break
      }

      case 'unwatch': {
        if (!args[1]) {
          terminal.writeln('Please provide a watch ID')
          return 1
        }
        const id = Number(args[1])
        const session = watches.get(id)
        if (!session) {
          terminal.writeln(`No sensor found with ID: ${id}`)
          return 1
        }
        watches.delete(id)
        await session.close()
        terminal.writeln(`Stopped watching sensor (ID: ${id})`)
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

/** `/sys/class/sensors` */
const sensors_class = new Class('sensors')

// Major 0 is a major of the package's own. The control node is minor 0; each sensor this browser has is a node of its own, by
// the sensor's place in the list of all kinds, so a number means the same sensor on every machine. Opening one starts the
// sensor (after its permission check) and closing the last open stops it.
export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  const drivers: KernelCharDevice[] = [{ name: 'sensors', major: 0, minor: 0, class: sensors_class, ops: controlOperations }]
  const ops = sessionOperations({ open: async minor => await openSensorSession(kinds[minor - 1]!) })
  kinds.forEach((kind, index) => {
    if (available(kind)) drivers.push({ name: `sensor-${kind}`, major: 0, minor: index + 1, class: sensors_class, ops })
  })
  return drivers
}
