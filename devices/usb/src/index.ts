/// <reference types="w3c-web-usb" />

import type { DeviceDriver } from '@zenfs/core'
import type { KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

export const pkg = {
  name: 'usb',
  version: '0.1.0',
  description: 'USB device driver'
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal } = options
  const usage = `
Usage: /dev/usb <command>

Commands:
  list                List all connected USB devices
  request             Request permission to access a USB device
  connect <id>        Connect to a specific USB device by vendor/product ID (e.g. 1234:5678)
  disconnect <id>     Disconnect from a specific USB device
  --help              Show this help message
`

  if (!navigator.usb) {
    terminal.writeln('WebUSB API not available')
    return 1
  }

  if (!args.length || args[0] === '--help') {
    terminal.writeln(usage)
    return 0
  }

  try {
    switch (args[0]) {
      case 'list': {
        const devices = await navigator.usb.getDevices()
        if (!devices.length) {
          terminal.writeln('No USB devices found')
          return 0
        }

        terminal.writeln('Connected USB devices:')
        for (const device of devices) {
          terminal.writeln(`  ${device.productName || 'Unknown Device'} (${device.vendorId.toString(16)}:${device.productId.toString(16)})`)
          terminal.writeln(`    Manufacturer: ${device.manufacturerName || 'Unknown'}`)
          terminal.writeln(`    Serial: ${device.serialNumber || 'Unknown'}`)
          terminal.writeln(`    Status: ${device.opened ? 'Connected' : 'Disconnected'}\n`)
        }
        break
      }

      case 'request': {
        try {
          const device = await navigator.usb.requestDevice({ filters: [] })
          terminal.writeln(`Requested access to: ${device.productName || 'Unknown Device'}`)
        } catch (err) {
          if (err instanceof Error && err.name === 'NotFoundError') {
            terminal.writeln('No device was selected')
          } else {
            throw err
          }
        }
        break
      }

      case 'connect': {
        if (!args[1]) {
          terminal.writeln('Please specify a device ID (e.g. usb connect 1234:5678)')
          return 1
        }

        const [vendorId, productId] = args[1].split(':').map(x => parseInt(x, 16))
        const devices = await navigator.usb.getDevices()
        const device = devices.find(d => d.vendorId === vendorId && d.productId === productId)
        
        if (!device) {
          terminal.writeln(`No device found with ID ${args[1]}`)
          return 1
        }

        await device.open()
        terminal.writeln(`Connected to ${device.productName || 'Unknown Device'}`)
        break
      }

      case 'disconnect': {
        if (!args[1]) {
          terminal.writeln('Please specify a device ID (e.g. usb disconnect 1234:5678)')
          return 1
        }

        const [vendorId, productId] = args[1].split(':').map(x => parseInt(x, 16))
        const devices = await navigator.usb.getDevices()
        const device = devices.find(d => d.vendorId === vendorId && d.productId === productId)
        
        if (!device) {
          terminal.writeln(`No device found with ID ${args[1]}`)
          return 1
        }

        await device.close()
        terminal.writeln(`Disconnected from ${device.productName || 'Unknown Device'}`)
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
  const drivers: DeviceDriver[] = [
    {
      name: 'usb',
      init: () => ({
        major: 8,
        minor: 0,
        data: { kernelId: ctx.id }
      }),
      read: () => 0,
      write: () => 0
    }
  ]

  if (navigator.usb) {
    const devices = await navigator.usb.getDevices()
    for (const device of devices) {
      drivers.push({
        name: `usb-${device.productName}-${device.vendorId}-${device.productId}`,
        init: () => ({
          major: 8,
          minor: device.vendorId + device.productId,
          data: { device, kernelId: ctx.id }
        }),
        read: () => 0,
        write: () => 0
      })
    }
  }

  return drivers
}
