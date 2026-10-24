/// <reference types="w3c-web-hid" />

import ansi from 'ansi-escape-sequences'
import { Class } from '@zenfs/linux'
import { fs } from '@zenfs/core'
import { controlOperations, fileMinorStore, sessionOperations, StableMinors } from '@ecmaos-devices/session'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

import { usesReportIds } from './descriptor.js'
import { hidrawIoctl, hidrawRequest } from './hidraw.js'
import { openHidSession } from './session.js'

export { openHidSession, HidError } from './session.js'
export { reportDescriptor, usesReportIds } from './descriptor.js'
export { hidrawIoctl, hidrawRequest } from './hidraw.js'
export type { HidDeviceSession } from './session.js'

export const pkg = {
  name: 'hid',
  version: '0.1.0',
  description: 'Human Interface Device (HID) driver'
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal } = options

  const usage = `
Usage: /dev/hid <command>

Commands:
  list                List available HID devices
  request             Request a new HID device connection
  connect <id>        Connect to a specific device
  disconnect <id>     Disconnect from a specific device
  info <id>           Show information about a connected device
  read <id>           Read from a device
  write <id> <data>   Write data to a device
  --help              Show this help message
`

  if (!('hid' in navigator)) {
    terminal.writeln('WebHID API not available')
    return 1
  }

  if (!args.length || args[0] === '--help') {
    terminal.writeln(usage)
    return 0
  }

  try {
    switch(args[0]) {
      case 'list':
        const devices = await navigator.hid.getDevices()
        const uniqueDevices = Array.from(new Map(devices.map(d => [d.productId, d])).values())
        
        if (!uniqueDevices.length) {
          terminal.writeln('No HID devices connected')
          break
        }
        
        terminal.writeln(`${ansi.style.bold}🎮 Connected HID Devices:${ansi.style.reset}`)
        uniqueDevices.forEach(device => {
          terminal.writeln(`
      📱 Device ID: ${ansi.style.cyan}${device.productId}${ansi.style.reset}
      📝 Name: ${ansi.style.cyan}${device.productName}${ansi.style.reset}
      🏢 Manufacturer: ${ansi.style.cyan}${device.vendorId}${ansi.style.reset}
      🔌 Connected: ${ansi.style.cyan}${device.opened ? 'Yes' : 'No'}${ansi.style.reset}`)
        })
        break

      case 'request':
        const device = await navigator.hid.requestDevice({
          filters: [] // Accept all devices
        })
        await syncHid()
        terminal.writeln(`Device requested: ${device[0]?.productName || 'No device selected'}`)
        break

      case 'connect':
        if (!args[1]) {
          terminal.writeln('Please provide a device ID')
          return 1
        }
        const connectDevices = await navigator.hid.getDevices()
        const deviceToConnect = connectDevices.find(d => d.productId === Number(args[1]))
        if (!deviceToConnect) {
          terminal.writeln(`Device with ID ${args[1]} not found`)
          return 1
        }
        
        if (deviceToConnect.opened) {
          terminal.writeln('Device is already connected')
          return 0
        }

        await deviceToConnect.open()
        terminal.writeln(`Connected to device: ${deviceToConnect.productName}`)
        break

      case 'disconnect':
        if (!args[1]) {
          terminal.writeln('Please provide a device ID')
          return 1
        }
        const disconnectDevices = await navigator.hid.getDevices()
        const deviceToDisconnect = disconnectDevices.find(d => d.productId === Number(args[1]))
        if (!deviceToDisconnect) {
          terminal.writeln(`Device with ID ${args[1]} not found`)
          return 1
        }
        
        if (!deviceToDisconnect.opened) {
          terminal.writeln('Device is already disconnected')
          return 0
        }

        await deviceToDisconnect.close()
        terminal.writeln(`Disconnected from device: ${deviceToDisconnect.productName}`)
        break

      case 'info':
        if (!args[1]) {
          terminal.writeln('Please provide a device ID')
          return 1
        }
        const devices2 = await navigator.hid.getDevices()
        const targetDevice = devices2.find(d => d.productId === Number(args[1]))
        if (!targetDevice) {
          terminal.writeln(`Device with ID ${args[1]} not found`)
          return 1
        }
        terminal.writeln(`${ansi.style.bold}Device Information:${ansi.style.reset}
      Product ID: ${targetDevice.productId}
      Vendor ID: ${targetDevice.vendorId}
      Product Name: ${targetDevice.productName}
      Connected: ${targetDevice.opened}`)
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

/** `/sys/class/hid` */
const hid_class = new Class('hid')

/** What names a device across boots: its ids and product name (devices that look alike are told apart by their order) */
const hidKey = (device: HIDDevice) => `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}:${device.productName}`
const minors = new StableMinors(fileMinorStore(fs as never, '/var/lib/ecmaos/hid-minors.json'))

export async function getDrivers(): Promise<KernelCharDevice[]> {
  return [{ name: 'hid', major: 0, minor: 64, class: hid_class, ops: controlOperations }]
}

/** The `hidraw<n>` nodes that exist, by minor, with what takes each away */
const nodes = new Map<number, () => void>()
let watching: KernelContext | undefined
let ops: ReturnType<typeof sessionOperations> | undefined

/**
 * Gives each device the user has allowed a node, in the order the browser lists them, and takes away the nodes of devices that
 * are gone. Run when the page starts, on the browser's `connect` and `disconnect`, and after `/dev/hid request`.
 */
export async function syncHid(ctx: KernelContext | undefined = watching): Promise<void> {
  if (!ctx || typeof navigator === 'undefined' || !('hid' in navigator)) return
  try {
    const devices = await navigator.hid.getDevices()
    // a device the browser has allowed is plugged in, so it is on the USB bus (WebHID does not say whether it is Bluetooth)
    ctx.usb.sync(pkg.name, devices.map(device => ({ vendor: device.vendorId, product: device.productId, name: device.productName || undefined })))
    ops ??= sessionOperations({
      async open(minor) {
        const devices = await navigator.hid.getDevices()
        const device = devices[await minors.find(devices.map(hidKey), minor)]
        if (!device) throw new Error('no such device')
        const session = await openHidSession(device)
        if (usesReportIds(device.collections)) return session
        // a node reads a device with unnumbered reports as Linux's hidraw does: the data alone, with no id in front
        const read = session.read!
        return { ...session, read: async () => (await read())?.subarray(1) }
      },
      packets: true,
      ioctl: { accepts: hidrawRequest, run: (session, request, arg) => hidrawIoctl(session, request, arg) },
      onError: error => (watching ?? ctx).log.warn(`hid: ${error.message}`)
    })
    const sessions = ops
    const numbers = await minors.assign(devices.map(hidKey))
    const names = StableMinors.unique(devices.map(hidKey)).map(key => key.split(':').slice(2).join(':'))
    numbers.forEach((minor, index) => {
      if (nodes.has(minor)) return
      const remove = ctx.devices.add(pkg.name, { name: `hidraw${minor - 1}`, major: 0, minor, class: hid_class, ops: sessions })
      nodes.set(minor, () => { remove(); sessions.hangup(minor) })
      ctx.log.info(`hid-generic: ${names[index] || 'device'} as /dev/hidraw${minor - 1}`)
    })
    for (const [minor, remove] of [...nodes]) {
      if (numbers.includes(minor)) continue
      remove()
      nodes.delete(minor)
      ctx.log.info(`hid-generic: /dev/hidraw${minor - 1} disconnected`)
    }
  } catch (error) {
    ctx.log.warn(`hid: cannot list devices: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Lists the devices already allowed, and follows the browser's `connect` and `disconnect` */
export async function watch(ctx: KernelContext): Promise<void> {
  const first = !watching
  watching = ctx
  await syncHid(ctx)
  if (first && typeof navigator !== 'undefined' && 'hid' in navigator) {
    const sync = () => { void syncHid() }
    navigator.hid.addEventListener('connect', sync)
    navigator.hid.addEventListener('disconnect', sync)
  }
}
