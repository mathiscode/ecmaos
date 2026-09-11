interface GeoCoordinates extends GeolocationCoordinates {
  toJSON: () => string
}

import ansi from 'ansi-escape-sequences'
import { Class } from '@zenfs/linux'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

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

export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  if (!('geolocation' in navigator)) return []

  let lastPosition: GeoCoordinates = {
    latitude: 0,
    longitude: 0,
    accuracy: 0,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
    toJSON: function() {
      return JSON.stringify({
        latitude: this.latitude,
        longitude: this.longitude,
        accuracy: this.accuracy,
        altitude: this.altitude
      })
    }
  }

  // Only start watching if permission is already granted
  const permission = await navigator.permissions.query({ name: 'geolocation' })
  if (permission.state === 'granted') {
    navigator.geolocation.watchPosition(
      (position) => {
        lastPosition = {
          ...position.coords,
          toJSON: function() {
            return JSON.stringify({
              latitude: this.latitude,
              longitude: this.longitude,
              accuracy: this.accuracy,
              altitude: this.altitude
            })
          }
        }
      },
      (error) => {
        console.warn('Geolocation error:', error)
      }
    )
  }

  return [{
    name: 'geo',
    major: 10,
    minor: 101,
    class: geo_class,
    ops: {
      read: (_file, buffer, start, end) => {
        const view = new Float64Array(buffer.buffer, buffer.byteOffset, 4)
        view.set([
          lastPosition.latitude,
          lastPosition.longitude,
          lastPosition.accuracy,
          lastPosition.altitude || 0
        ])

        return Math.min(32, end - start)
      },
      write: () => {}
    }
  }]
}
