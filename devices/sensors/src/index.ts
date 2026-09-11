/// <reference types="w3c-generic-sensor" />

import ansi from 'ansi-escape-sequences'
import type { DeviceDriver } from '@zenfs/core'
import type { KernelContext, KernelDeviceCLIOptions, KernelDeviceData } from '@ecmaos/types'

export const pkg = {
  name: 'sensors',
  version: '0.1.0',
  description: 'Device sensors driver'
}

type SensorType = 'accelerometer' | 'gyroscope' | 'linear' | 'orientation'
// type SensorEventCallback = (event: Event) => void

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
`

  if (!args.length || args[0] === '--help') {
    terminal.writeln(usage)
    return 0
  }

  try {
    switch(args[0]) {
      case 'list':
        const sensors: SensorType[] = []
        if ('Accelerometer' in globalThis) sensors.push('accelerometer')
        if ('Gyroscope' in globalThis) sensors.push('gyroscope')
        if ('LinearAccelerationSensor' in globalThis) sensors.push('linear')
        if ('AbsoluteOrientationSensor' in globalThis) sensors.push('orientation')
        
        terminal.writeln(`${ansi.style.bold}📱 Available Sensors:${ansi.style.reset}`)
        sensors.forEach(sensor => terminal.writeln(`  - ${sensor}`))
        break

      case 'read':
        if (!args[1]) {
          terminal.writeln('Please specify a sensor')
          return 1
        }
        const sensorToRead = args[1] as SensorType
        if (!isSensorType(sensorToRead)) {
          terminal.writeln(`Invalid sensor type: ${args[1]}`)
          terminal.writeln('Available sensors: accelerometer, gyroscope, linear, orientation')
          return 1
        }
        await readSensor(sensorToRead, terminal)
        break

      case 'watch':
        if (!args[1]) {
          terminal.writeln('Please specify a sensor')
          return 1
        }
        const sensorToWatch = args[1] as SensorType
        if (!isSensorType(sensorToWatch)) {
          terminal.writeln(`Invalid sensor type: ${args[1]}`)
          terminal.writeln('Available sensors: accelerometer, gyroscope, linear, orientation')
          return 1
        }
        const newWatchId = await watchSensor(sensorToWatch, terminal)
        terminal.writeln(`Started watching ${args[1]} (ID: ${newWatchId})`)
        break

      case 'unwatch':
        if (!args[1]) {
          terminal.writeln('Please provide a watch ID')
          return 1
        }
        const watchIdToRemove = Number(args[1])
        const sensor = activeSensors.get(watchIdToRemove)
        if (sensor) {
          sensor.stop()
          activeSensors.delete(watchIdToRemove)
          terminal.writeln(`Stopped watching sensor (ID: ${watchIdToRemove})`)
        } else {
          terminal.writeln(`No sensor found with ID: ${watchIdToRemove}`)
          return 1
        }
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

export async function getDrivers(ctx: KernelContext): Promise<DeviceDriver<KernelDeviceData>[]> {
  const drivers: DeviceDriver<KernelDeviceData>[] = [{
    name: 'sensors',
    init: () => ({ major: 10, minor: 102, data: { kernelId: ctx.id, version: pkg.version } }),
    read: () => 0,
    write: () => 0
  }]

  return drivers
}

const activeSensors = new Map<number, any>()
let watchCounter = 0

async function readSensor(sensorType: SensorType, terminal: any) {
  try {
    // First create the sensor instance
    let sensor
    switch (sensorType) {
      case 'accelerometer':
        sensor = new Accelerometer({ frequency: 60 })
        break
      case 'gyroscope':
        sensor = new Gyroscope({ frequency: 60 })
        break
      case 'linear':
        sensor = new LinearAccelerationSensor({ frequency: 60 })
        break
      case 'orientation':
        sensor = new AbsoluteOrientationSensor({ frequency: 60 })
        break
      default:
        terminal.writeln(`Invalid sensor type: ${sensorType}`)
        return
    }

    // Then check permissions
    let permissions: Promise<PermissionStatus>[] = []
    switch(sensorType) {
      case 'orientation':
        permissions = [
          navigator.permissions.query({ name: 'accelerometer' as PermissionName }),
          navigator.permissions.query({ name: 'magnetometer' as PermissionName }),
          navigator.permissions.query({ name: 'gyroscope' as PermissionName })
        ]
        break
      case 'accelerometer':
      case 'linear':
        permissions = [navigator.permissions.query({ name: 'accelerometer' as PermissionName })]
        break
      case 'gyroscope':
        permissions = [navigator.permissions.query({ name: 'gyroscope' as PermissionName })]
        break
    }

    const results = await Promise.all(permissions)
    if (!results.every((result) => result.state === 'granted')) {
      terminal.writeln('Required sensor permissions not granted')
      return
    }

    return new Promise<void>((resolve) => {
      const handleReading = function(this: typeof sensor) {
        displaySensorData(sensor, sensorType, terminal)
        sensor.stop()
        ;(sensor as any).removeEventListener('reading', handleReading)
        resolve()
      }

      const handleError = (error: Error) => {
        terminal.writeln(`Sensor error: ${error.message}`)
        sensor.stop()
        ;(sensor as any).removeEventListener('reading', handleReading)
        ;(sensor as any).removeEventListener('error', handleError)
        resolve()
      }

      ;(sensor as any).addEventListener('reading', handleReading)
      ;(sensor as any).addEventListener('error', handleError)
      
      sensor.start()
      terminal.writeln('Reading sensor...')

      setTimeout(() => {
        sensor.stop()
        ;(sensor as any).removeEventListener('reading', handleReading)
        ;(sensor as any).removeEventListener('error', handleError)
        terminal.writeln('Sensor reading timed out')
        resolve()
      }, 5000)
    })
  } catch (error) {
    terminal.writeln(`Error reading sensor: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function watchSensor(sensorType: SensorType, terminal: any) {
  try {
    const sensor = await createSensor(sensorType)
    if (!sensor) {
      terminal.writeln(`Sensor ${sensorType} not available`)
      return -1
    }

    const watchId = ++watchCounter
    activeSensors.set(watchId, sensor)

    const handleReading = function(this: typeof sensor, _: Event) {
      displaySensorData(sensor, sensorType, terminal)
    }

    ;(sensor as any).addEventListener('reading', handleReading)
    sensor.start()
    return watchId
  } catch (error) {
    terminal.writeln(`Error watching sensor: ${error instanceof Error ? error.message : String(error)}`)
    return -1
  }
}

async function requestSensorPermissions(sensorType: SensorType): Promise<boolean> {
  try {
    let permissions: Promise<PermissionStatus>[] = []
    
    switch(sensorType) {
      case 'orientation':
        permissions = [
          navigator.permissions.query({ name: 'accelerometer' as PermissionName }),
          navigator.permissions.query({ name: 'magnetometer' as PermissionName }),
          navigator.permissions.query({ name: 'gyroscope' as PermissionName })
        ]
        break
      case 'accelerometer':
        permissions = [navigator.permissions.query({ name: 'accelerometer' as PermissionName })]
        break
      case 'gyroscope':
        permissions = [navigator.permissions.query({ name: 'gyroscope' as PermissionName })]
        break
      case 'linear':
        permissions = [navigator.permissions.query({ name: 'accelerometer' as PermissionName })]
        break
    }

    const results = await Promise.all(permissions)
    return results.every((result) => result.state === 'granted')
  } catch (error) {
    console.error('Error requesting permissions:', error)
    return false
  }
}

async function createSensor(sensorType: SensorType) {
  const hasPermission = await requestSensorPermissions(sensorType)
  if (!hasPermission) {
    console.log(`No permissions granted for ${sensorType}`)
    return null
  }

  let sensor
  switch (sensorType) {
    case 'accelerometer':
      sensor = new Accelerometer({ frequency: 60 })
      console.log('Created accelerometer:', sensor)
      return sensor
    case 'gyroscope':
      sensor = new Gyroscope({ frequency: 60 })
      console.log('Created gyroscope:', sensor)
      return sensor
    case 'linear':
      sensor = new LinearAccelerationSensor({ frequency: 60 })
      console.log('Created linear sensor:', sensor)
      return sensor
    case 'orientation':
      sensor = new AbsoluteOrientationSensor({ frequency: 60 })
      console.log('Created orientation sensor:', sensor)
      return sensor
    default:
      return null
  }
}

function displaySensorData(sensor: any, sensorType: SensorType, terminal: any) {
  const timestamp = new Date().toISOString()

  switch (sensorType) {
    case 'accelerometer':
    case 'linear':
      terminal.writeln(`${ansi.style.bold}📊 ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)} Reading:${ansi.style.reset}
        🕒 Time: ${ansi.style.cyan}${timestamp}${ansi.style.reset}
        X: ${ansi.style.cyan}${sensor.x.toFixed(2)}${ansi.style.reset} m/s²
        Y: ${ansi.style.cyan}${sensor.y.toFixed(2)}${ansi.style.reset} m/s²
        Z: ${ansi.style.cyan}${sensor.z.toFixed(2)}${ansi.style.reset} m/s²`)
      break
    case 'gyroscope':
      terminal.writeln(`${ansi.style.bold}📊 Gyroscope Reading:${ansi.style.reset}
        🕒 Time: ${ansi.style.cyan}${timestamp}${ansi.style.reset}
        X: ${ansi.style.cyan}${sensor.x.toFixed(2)}${ansi.style.reset} rad/s
        Y: ${ansi.style.cyan}${sensor.y.toFixed(2)}${ansi.style.reset} rad/s
        Z: ${ansi.style.cyan}${sensor.z.toFixed(2)}${ansi.style.reset} rad/s`)
      break
    case 'orientation':
      terminal.writeln(`${ansi.style.bold}📊 Orientation Reading:${ansi.style.reset}
        🕒 Time: ${ansi.style.cyan}${timestamp}${ansi.style.reset}
        Quaternion:
        X: ${ansi.style.cyan}${sensor.quaternion[0].toFixed(3)}${ansi.style.reset}
        Y: ${ansi.style.cyan}${sensor.quaternion[1].toFixed(3)}${ansi.style.reset}
        Z: ${ansi.style.cyan}${sensor.quaternion[2].toFixed(3)}${ansi.style.reset}
        W: ${ansi.style.cyan}${sensor.quaternion[3].toFixed(3)}${ansi.style.reset}`)
      break
  }
}

function isSensorType(value: string): value is SensorType {
  return ['accelerometer', 'gyroscope', 'linear', 'orientation'].includes(value)
}
