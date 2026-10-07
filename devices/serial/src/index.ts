/// <reference types="w3c-web-serial" />

import { Class, EPOLLIN, EPOLLOUT, WaitQueue } from '@zenfs/linux'
import type { FileOperations } from '@zenfs/linux'
import { withErrno } from 'kerium'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

import { openSerialSession } from './session.js'
import type { SerialDeviceSession } from './session.js'

export { openSerialSession, SerialError } from './session.js'
export type { SerialDeviceSession, SerialSessionOptions } from './session.js'

const availablePorts = new Set<SerialPort>()

export const pkg = {
  name: 'serial',
  version: '0.1.0',
  description: 'Web Serial device driver',
  help: `
  Note: This is experimental technology

  Please check the compatibility table at:
  https://developer.mozilla.org/en-US/docs/Web/API/Navigator/serial#browser_compatibility

  Usage:
    serial devices                       List paired serial devices
    serial request <options>             Request serial device (blank for user choice)

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
          return { index, usbProductId, usbVendorId }
        })
      )
      terminal.writeln(JSON.stringify(data, null, 2))
      return 0
    }

    case 'request': {
      const vendorIndex = args.indexOf('--vendor')
      const productIndex = args.indexOf('--product')
      const filter: any = {}
      
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
        terminal.writeln(`Device connected: ${JSON.stringify(await device.getInfo())}`)
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

/** What an open `/dev/ttyS<n>` is: the port, opened when the node is, and the bytes it has produced that nobody has read yet */
interface Link {
  session?: SerialDeviceSession
  chunks: Uint8Array[]
  size: number
  /** Bytes handed to the port that it has not taken yet */
  pending: number
  queue: WaitQueue
  /** The port has ended (unplugged, closed) or could not be opened */
  ended: boolean
  failure?: string
  references: number
}

/** The most that may be waiting to be written to a port before a writer has to wait */
const MaxPending = 64 * 1024

const links = new Map<number, Link>()

async function start(minor: number, link: Link) {
  try {
    const port = (await navigator.serial.getPorts())[minor - 1]
    if (!port) throw new Error('no such port')
    // A speed is chosen with the 'serial' CLI or by serving the port to another machine; a local node opens at 9600
    const session = await openSerialSession(port)
    if (link.references === 0) { void session.close(); return }
    link.session = session
    link.queue.wake_up()
    for (;;) {
      const chunk = await session.read()
      if (!chunk) break
      link.chunks.push(chunk)
      link.size += chunk.length
      link.queue.wake_up()
    }
  } catch (error) {
    link.failure = error instanceof Error ? error.message : String(error)
  } finally {
    link.ended = true
    link.queue.wake_up()
  }
}

/**
 * A serial port as a file. It follows the pattern of a socket: bytes the port produces go into a buffer a read drains, a read
 * with nothing to give sleeps on the queue until the port has some (or has ended: then it reads as the end of the file), and
 * a write is handed to the port, taking only what the port has room for.
 */
function serialOperations(): FileOperations {
  const link = (file: { devt: { minor: number } }) => {
    const found = links.get(file.devt.minor)
    if (!found) throw withErrno('EBADF')
    return found
  }
  return {
    open: file => {
      let found = links.get(file.devt.minor)
      if (!found) {
        found = { chunks: [], size: 0, pending: 0, queue: new WaitQueue(), ended: false, references: 0 }
        links.set(file.devt.minor, found)
        void start(file.devt.minor, found)
      }
      found.references++
    },
    release: file => {
      const found = links.get(file.devt.minor)
      if (!found || --found.references > 0) return
      links.delete(file.devt.minor)
      void found.session?.close()
      found.ended = true
      found.queue.wake_up()
    },
    read: (file, buffer, start, end) => {
      const found = link(file)
      if (found.failure && found.size === 0) throw withErrno('EIO', found.failure)
      let done = 0
      while (done < end - start && found.chunks.length) {
        const chunk = found.chunks[0]!
        const count = Math.min(chunk.length, end - start - done)
        buffer.set(chunk.subarray(0, count), start + done)
        done += count
        if (count === chunk.length) found.chunks.shift()
        else found.chunks[0] = chunk.subarray(count)
      }
      found.size -= done
      return done
    },
    write: (file, buffer, offset) => {
      const found = link(file)
      if (found.ended) throw withErrno('EIO', found.failure ?? 'the port has closed')
      const session = found.session
      if (!session) throw withErrno('EAGAIN', 'the port is opening')
      const count = Math.min(buffer.length - offset, MaxPending - found.pending)
      if (count <= 0) throw withErrno('EAGAIN')
      // The caller's buffer is reused as soon as this returns
      const data = buffer.slice(offset, offset + count)
      found.pending += count
      session.write(data).catch(error => { found.failure = error instanceof Error ? error.message : String(error); found.ended = true }).finally(() => { found.pending -= count; found.queue.wake_up() })
      return count
    },
    poll: file => {
      const found = links.get(file.devt.minor)
      if (!found) return EPOLLIN | EPOLLOUT
      let events = 0
      if (found.size > 0 || found.ended) events |= EPOLLIN
      if (found.ended || (found.session && found.pending < MaxPending)) events |= EPOLLOUT
      return events
    },
    poll_wait: file => links.get(file.devt.minor)?.queue
  }
}

// Dynamically allocated: real Linux major 4 is tty/ttyS, which @zenfs/linux's own xterm_driver
// (TTYDriver) claims for the console TTYs. WebSerial ports are not that line discipline, so they
// get their own major rather than colliding with it.
function createDriver(name: string, minor: number): KernelCharDevice {
  return { name, major: 0, minor, class: serial_class, ops: minor === 0 ? { read: () => 0, write: (_file, buffer, offset) => buffer.length - offset } : serialOperations() }
}

export async function getDrivers(ctx: KernelContext): Promise<KernelCharDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.serial) return []
  navigator.serial.addEventListener('connect', async (event) => {
    ctx.events.emit('device:connect', event.target)
    if (event.target && !availablePorts.has(event.target as SerialPort)) {
      availablePorts.add(event.target as SerialPort)
    }

    console.log({ availablePorts })
  })

  const drivers: KernelCharDevice[] = [createDriver('serial', 0)]
  const ports = await navigator.serial.getPorts()
  ports.forEach((_port, i) => drivers.push(createDriver(`ttyS${i}`, i + 1)))
  return drivers
}
