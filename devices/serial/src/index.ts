/// <reference types="w3c-web-serial" />

import { Class } from '@zenfs/linux'
import type { TTYDriver } from '@zenfs/linux'
import { controlOperations } from '@ecmaos-devices/session'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

import { attachPort, detachPort, lineName, serialTerminals } from './tty.js'

export { openSerialSession, SerialError } from './session.js'
export type { SerialDeviceSession, SerialSessionOptions } from './session.js'
export { acmDriver, attachPort, detachPort, lineName, rfcommDriver, speedOf, supportedCflag, usbSerialDriver } from './tty.js'

export const pkg = {
  name: 'serial',
  version: '0.1.0',
  description: 'Web Serial device driver',
  help: `
  Note: This is experimental technology

  Please check the compatibility table at:
  https://developer.mozilla.org/en-US/docs/Web/API/Navigator/serial#browser_compatibility

  Usage:
    serialctl devices                    List the ports this browser has granted, with their nodes
    serialctl request <options>          Ask for a port (blank for the browser's choice); it becomes /dev/ttyACM<n>,
                                         /dev/ttyUSB<n> (a USB-serial bridge chip) or /dev/rfcomm<n> (Bluetooth)

  Options:
    --help                               Print this help message
    --product                            Product ID of the serial device
    --vendor                             Vendor ID of the serial device
    --version                            Print the version information
  `
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal } = options
  
  // Check if Web Serial is available
  if (typeof navigator === 'undefined' || !navigator.serial) {
    terminal.writeln('Error: Client does not support Web Serial')
    return 1
  }

  // Handle commands
  switch (args[0]) {
    case 'devices': {
      const devices = await navigator.serial.getPorts()
      const data = await Promise.all(
        devices.map(async (device, index) => {
          const { usbProductId, usbVendorId } = await device.getInfo()
          return { index, node: lineName(device) ? `/dev/${lineName(device)}` : null, usbProductId, usbVendorId }
        })
      )
      terminal.writeln(JSON.stringify(data, null, 2))
      return 0
    }

    case 'request': {
      const vendorIndex = args.indexOf('--vendor')
      const productIndex = args.indexOf('--product')
      const filter: { usbVendorId?: number, usbProductId?: number } = {}
      
      if (vendorIndex !== -1 && args[vendorIndex + 1]) {
        filter.usbVendorId = parseInt(args[vendorIndex + 1] || '')
      }
      if (productIndex !== -1 && args[productIndex + 1]) {
        filter.usbProductId = parseInt(args[productIndex + 1] || '')
      }
      
      try {
        const device = await navigator.serial.requestPort({
          filters: Object.keys(filter).length ? [filter] : []
        })
        terminal.writeln(`/dev/${attachPort(device)}: ${JSON.stringify(device.getInfo())}`)
        return 0
      } catch (err) {
        terminal.writeln(`Error: Failed to request device: ${err}`)
        return 1
      }
    }

    default:
      terminal.writeln(pkg.help)
      return 0
  }
}

/** `/sys/class/serial` */
const serial_class = new Class('serial')

let listening = false

/** `/dev/serialctl`, the control node (`/dev/serial` is the directory of `by-id` links); the ports are terminals (see `getTTYDrivers`) */
export async function getDrivers(ctx: KernelContext): Promise<KernelCharDevice[]> {
  const control: KernelCharDevice = { name: 'serialctl', major: 0, minor: 0, class: serial_class, ops: controlOperations }
  if (typeof navigator === 'undefined' || !navigator.serial || listening) return [control]
  listening = true
  // A port that is plugged in gets its line, and one that is unplugged hangs its line up
  navigator.serial.addEventListener('connect', event => {
    ctx.events.emit('device:connect', event.target)
    attachPort(event.target as SerialPort)
  })
  navigator.serial.addEventListener('disconnect', event => detachPort(event.target as SerialPort))
  return [control]
}

/** `ttyACM<n>`, `ttyUSB<n>` and `rfcomm<n>`, with a line for each port already granted */
export async function getTTYDrivers(ctx: KernelContext): Promise<TTYDriver[]> {
  return await serialTerminals(ctx)
}
