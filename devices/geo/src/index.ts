import ansi from 'ansi-escape-sequences'
import { Class } from '@zenfs/linux'
import { sessionOperations, firstReading } from '@ecmaos-devices/session'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

import { openGeoSession } from './session.js'

export { openGeoSession } from './session.js'

export const pkg = {
  name: 'geo',
  version: '0.1.0',
  description: 'Geolocation device driver'
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal } = options

  const usage = `
Usage: /dev/geo <command>

Commands:
  position           Show current position
  watch              Start watching position changes
  unwatch            Stop watching position changes
  --help             Show this help message
`

  if (!('geolocation' in navigator)) {
    terminal.writeln('Geolocation API not available')
    return 1
  }

  if (!args.length || args[0] === '--help') {
    terminal.writeln(usage)
    return 0
  }

  try {
    switch(args[0]) {
      case 'position':
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject)
        })

        terminal.writeln(`${ansi.style.bold}📍 Current Position:${ansi.style.reset}
      🌍 Latitude: ${ansi.style.cyan}${position.coords.latitude}${ansi.style.reset}
      🌍 Longitude: ${ansi.style.cyan}${position.coords.longitude}${ansi.style.reset}
      📏 Accuracy: ${ansi.style.cyan}${position.coords.accuracy}m${ansi.style.reset}
      🏔️ Altitude: ${position.coords.altitude ? ansi.style.cyan + position.coords.altitude + 'm' : ansi.style.gray + 'N/A'}${ansi.style.reset}
      🎯 Altitude Accuracy: ${position.coords.altitudeAccuracy ? ansi.style.cyan + position.coords.altitudeAccuracy + 'm' : ansi.style.gray + 'N/A'}${ansi.style.reset}
      🧭 Heading: ${position.coords.heading ? ansi.style.cyan + position.coords.heading + '°' : ansi.style.gray + 'N/A'}${ansi.style.reset}
      🚀 Speed: ${position.coords.speed ? ansi.style.cyan + position.coords.speed + 'm/s' : ansi.style.gray + 'N/A'}${ansi.style.reset}`)
        break
      
      case 'watch':
        const watchId = navigator.geolocation.watchPosition(
          (position) => {
            terminal.writeln(`📍 Position Update: ${position.coords.latitude}, ${position.coords.longitude}`)
          },
          (error) => {
            terminal.writeln(`Error: ${error.message}`)
          }
        )
        terminal.writeln(`Started watching position (ID: ${watchId})`)
        break
      
      case 'unwatch':
        if (!args[1]) {
          terminal.writeln('Please provide a watch ID')
          return 1
        }
        navigator.geolocation.clearWatch(Number(args[1]))
        terminal.writeln(`Stopped watching position (ID: ${args[1]})`)
        break
      
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

/** `/sys/class/geo` */
const geo_class = new Class('geo')

// A read waits for a fix and gives it as one JSON line, and then the end of the file; the position is asked for when the node is
// opened, so nothing is watched while no one reads
export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return []
  return [{
    name: 'geo',
    major: 10,
    minor: 101,
    class: geo_class,
    ops: sessionOperations({ open: async () => firstReading(await openGeoSession()) })
  }]
}
