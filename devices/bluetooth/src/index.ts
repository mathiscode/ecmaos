/// <reference types="@types/web-bluetooth" />

import { Class } from '@zenfs/linux'
import { fs } from '@zenfs/core'
import { sessionOperations } from '@ecmaos-devices/session'
import type { DeviceSession } from '@ecmaos-devices/session'
import type { FileOperations } from '@zenfs/linux'
import type { Kernel, KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

import { bluetoothOptionsFor, CONFIG_PATH } from './config.js'
import { openBluetoothSession } from './session.js'

export { openBluetoothSession } from './session.js'
export type { BluetoothSessionOptions } from './session.js'
export { bluetoothOptionsFor, NORDIC_UART, CONFIG_PATH } from './config.js'

export const pkg = {
  name: 'bluetooth',
  version: '0.1.0',
  description: 'Web Bluetooth API device driver'
}

/** Sessions the `connect` command opened, by device id, so later commands reuse the connection */
const connected = new Map<string, DeviceSession>()

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ')
const printable = (bytes: Uint8Array) => bytes.every(byte => byte === 10 || (byte >= 32 && byte < 127))

async function pairedDevice(id: string): Promise<BluetoothDevice | undefined> {
  return (await navigator.bluetooth.getDevices()).find(device => device.id === id)
}

async function sessionFor(id: string, terminal: { writeln(text: string): void }): Promise<DeviceSession | undefined> {
  const existing = connected.get(id)
  if (existing) return existing
  const device = await pairedDevice(id)
  if (!device) {
    terminal.writeln('Device not found. Pair it first with the scan command')
    return undefined
  }
  const session = await openBluetoothSession(device)
  connected.set(id, session)
  return session
}

export async function cli(options: KernelDeviceCLIOptions) {
  const { args, terminal, kernel } = options

  if (!navigator?.bluetooth) {
    terminal.writeln('Bluetooth API not available')
    return 1
  }

  async function ensureBluetoothPermission(): Promise<boolean> {
    if (kernel.storage.local.getItem('permission:bluetooth') === '1') return true
    if (kernel.storage.session.getItem('hide:permission:bluetooth') === '1') return false

    return new Promise((resolve) => {
      const win = kernel.windows.create({
        id: 'bluetooth-permission',
        title: 'Bluetooth Permission',
        modal: true,
        height: 250,
        html: `
          <p style='font-weight:bold; text-align:center'>Do you want to enable Bluetooth?</p>
          <button class="request-permission-bluetooth btn-success">Enable Bluetooth</button>
          <button class="request-permission-bluetooth-cancel btn-cancel">Cancel</button>
        `
      })

      // @ts-expect-error - the window's dom element is typed too loosely for querySelector
      win.dom.querySelector('.request-permission-bluetooth').addEventListener('click', async () => {
        try {
          await navigator.bluetooth.requestDevice({ acceptAllDevices: true })
          kernel.storage.local.setItem('permission:bluetooth', '1')
          win.close()
          resolve(true)
        } catch (error) {
          kernel.log.error('Error requesting Bluetooth device', error)
          kernel.storage.session.removeItem('permission:bluetooth')
          // kernel.storage.session.setItem('hide:permission:bluetooth', '1')
          win.close()

          const dialog = kernel.windows.dialog({
            title: '⚠️ Error',
            height: 250,
            html: `
              <p>Error requesting Bluetooth device</p>
              <code>${error}</code>
              <button class="request-permission-bluetooth-error-close btn-cancel">Close</button>
            `
          })

          // @ts-expect-error - the window's dom element is typed too loosely for querySelector
          dialog.dom.querySelector('.request-permission-bluetooth-error-close').addEventListener('click', () => dialog.close())
          resolve(false)
        }
      })

      // @ts-expect-error - the window's dom element is typed too loosely for querySelector
      win.dom.querySelector('.request-permission-bluetooth-cancel').addEventListener('click', () => {
        win.close()
        resolve(false)
      })
    })
  }

  if (args[0] !== '--help' && !(await ensureBluetoothPermission())) {
    terminal.writeln('Bluetooth permission denied')
    return 1
  }

  const usage = `
Usage: /dev/bluetooth <command>

Commands:
  scan [service]           Pair a device, optionally filtering by service UUID
  connect <id>             Connect to a paired device by ID
  disconnect <id>          Disconnect from a specific Bluetooth device
  services <id>            List services available on connected device
  characteristics <id>     List characteristics for a service
  read <id> <char>         Read value from characteristic
  write <id> <char> <val>  Write value to characteristic
  notify <id> <char>       Subscribe to notifications from characteristic
  list                     List paired devices

Paired devices appear as /dev/ble0, /dev/ble1 ... after a reload. Their stream\nsettings come from /etc/bluetooth.toml (default: Nordic UART).
  --help                   Show this help message
`

  if (!args.length || args[0] === '--help') {
    terminal.writeln(usage)
    return 0
  }


  try {
    const command = args[0]!
    const need = (count: number, what: string) => {
      if (args.length <= count) { terminal.writeln(`${what} required`); return false }
      return true
    }

    switch (command) {
      case 'scan': {
        terminal.writeln('Requesting Bluetooth device...')
        let device: BluetoothDevice
        try {
          device = await navigator.bluetooth.requestDevice({
            ...(args[1] ? { filters: [{ services: [args[1]] }] } : { acceptAllDevices: true }),
            optionalServices: ['generic_access']
          })
        } catch (error) {
          if (error instanceof DOMException && error.name === 'NotFoundError') {
            terminal.writeln('No device selected')
            return 1
          }
          throw error
        }
        terminal.writeln(`Paired: ${device.name || 'Unnamed'} (${device.id})`)
        break
      }

      case 'connect': {
        if (!need(1, 'Device ID')) return 1
        const session = await sessionFor(args[1]!, terminal)
        if (!session) return 1
        terminal.writeln(`Connected to ${session.info.name || 'Unnamed'}`)
        break
      }

      case 'disconnect': {
        if (!need(1, 'Device ID')) return 1
        const session = connected.get(args[1]!)
        if (!session) {
          terminal.writeln('Not connected')
          return 1
        }
        connected.delete(args[1]!)
        await session.close()
        terminal.writeln('Disconnected')
        break
      }

      case 'services': {
        if (!need(1, 'Device ID')) return 1
        const session = await sessionFor(args[1]!, terminal)
        if (!session) return 1
        terminal.writeln('Available services:')
        for (const uuid of await session.control!('services', []) as string[]) terminal.writeln(`  ${uuid}`)
        break
      }

      case 'characteristics': {
        if (!need(2, 'Device ID and service UUID')) return 1
        const session = await sessionFor(args[1]!, terminal)
        if (!session) return 1
        terminal.writeln('Available characteristics:')
        const found = await session.control!('characteristics', [args[2]!]) as Array<Record<string, string | boolean>>
        for (const characteristic of found) {
          const flags = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter(flag => characteristic[flag]).join(',')
          terminal.writeln(`  ${characteristic.uuid} [${flags}]`)
        }
        break
      }

      case 'read': {
        if (!need(3, 'Device ID, service UUID and characteristic UUID')) return 1
        const session = await sessionFor(args[1]!, terminal)
        if (!session) return 1
        const value = await session.control!('read', [args[2]!, args[3]!]) as Uint8Array
        terminal.writeln(printable(value) ? `Value: ${new TextDecoder().decode(value)}` : `Value: ${hex(value)}`)
        break
      }

      case 'write': {
        if (!need(4, 'Device ID, service UUID, characteristic UUID and value')) return 1
        const session = await sessionFor(args[1]!, terminal)
        if (!session) return 1
        await session.control!('write', [args[2]!, args[3]!, new TextEncoder().encode(args.slice(4).join(' '))])
        terminal.writeln('Value written successfully')
        break
      }

      case 'notify': {
        if (!need(3, 'Device ID, service UUID and characteristic UUID')) return 1
        const session = await sessionFor(args[1]!, terminal)
        if (!session) return 1
        session.emit = (name, data) => {
          if (name !== 'notify' || !data || typeof data !== 'object' || Array.isArray(data) || data instanceof Uint8Array) return
          const value = data.value
          if (value instanceof Uint8Array) terminal.writeln(`Notification: ${printable(value) ? new TextDecoder().decode(value) : hex(value)}`)
        }
        await session.control!('subscribe', [args[2]!, args[3]!])
        terminal.writeln('Listening for notifications (disconnect to stop)...')
        break
      }

      case 'list': {
        const devices = await navigator.bluetooth.getDevices()
        if (!devices.length) {
          terminal.writeln('No paired devices')
          return 0
        }
        terminal.writeln('Paired devices:')
        for (const device of devices) terminal.writeln(`  ${device.name || 'Unnamed'} (${device.id})${connected.has(device.id) ? ' [connected]' : ''}`)
        break
      }

      default:
        terminal.writeln(`Unknown command: ${command}`)
        terminal.writeln(usage)
        return 1
    }

    return 0
  } catch (error) {
    terminal.writeln(`Error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** `/sys/class/bluetooth` */
const bluetooth_class = new Class('bluetooth')

/**
 * A paired device as a file: `sessionOperations` does the buffering and waiting. Node N is the Nth paired device; the
 * stream settings come from `/etc/bluetooth.toml` (see `bluetoothOptionsFor`), defaulting to the Nordic UART service.
 */
const bluetoothOperations = (): FileOperations => sessionOperations({
  async open(minor) {
    const device = (await navigator.bluetooth.getDevices())[minor - 1]
    if (!device) throw new Error('no such device')
    const text = await fs.promises.readFile(CONFIG_PATH, 'utf8').catch(() => undefined)
    return await openBluetoothSession(device, bluetoothOptionsFor(text, device))
  }
})

export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) return []
  const devices = typeof navigator.bluetooth.getDevices === 'function' ? await navigator.bluetooth.getDevices() : []
  return [
    { name: 'bluetooth', major: 216, minor: 0, class: bluetooth_class, ops: { read: () => 0, write: (_file, buffer, offset) => buffer.length - offset } },
    ...devices.map((_device, index): KernelCharDevice => ({ name: `ble${index}`, major: 216, minor: index + 1, class: bluetooth_class, ops: bluetoothOperations() }))
  ]
}
