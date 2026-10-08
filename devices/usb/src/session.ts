/// <reference types="w3c-web-usb" />

import { Feed, isPlainMap, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession, Plain } from '@ecmaos-devices/session'

export interface UsbSessionOptions {
  /** The configuration to select; default: the one the device has selected, or the first */
  configuration?: number
  /** The interface to claim; default 0 */
  interface?: number
  /** Endpoint number to read bulk or interrupt transfers from (the IN endpoint, 1 to 15) */
  in?: number
  /** Endpoint number to write bulk or interrupt transfers to (the OUT endpoint, 1 to 15) */
  out?: number
}

const requestTypes = ['standard', 'class', 'vendor']
const recipients = ['device', 'interface', 'endpoint', 'other']
const int = (value: Plain | undefined, max: number): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined

/** Reads the setup packet of a control call: `{type, recipient, request, value, index}`; refuses anything out of range */
function setupOf(value: Plain | undefined): USBControlTransferParameters {
  if (!isPlainMap(value)) throw new SessionError('EINVAL', 'give {type, recipient, request, value, index}')
  const requestType = value['type']
  const recipient = value['recipient']
  const request = int(value['request'], 255)
  const wValue = int(value['value'] ?? 0, 65535)
  const index = int(value['index'] ?? 0, 65535)
  if (typeof requestType !== 'string' || !requestTypes.includes(requestType) || typeof recipient !== 'string' || !recipients.includes(recipient) || request === undefined || wValue === undefined || index === undefined) {
    throw new SessionError('EINVAL', 'type is standard, class or vendor; recipient is device, interface, endpoint or other; request, value and index are numbers')
  }
  return { requestType: requestType as USBRequestType, recipient: recipient as USBRecipient, request, value: wValue, index }
}

/**
 * A USB device the user has given the page, as a device session. It opens the device, selects a configuration, claims an
 * interface, and then streams: reads are what the IN endpoint sends (one transfer per chunk), writes go to the OUT endpoint.
 * Control transfers, which every device has, are the controls `control-in` and `control-out`; `info`, `reset`, `clear-halt`
 * and `select-alt` round it out.
 */
export async function openUsbSession(device: USBDevice, options: UsbSessionOptions = {}): Promise<DeviceSession> {
  await device.open()
  try {
    if (options.configuration !== undefined) await device.selectConfiguration(options.configuration)
    else if (device.configuration === null) await device.selectConfiguration(1)
    const iface = options.interface ?? 0
    await device.claimInterface(iface)
  } catch (error) {
    await device.close().catch(() => {})
    throw new SessionError('EIO', error instanceof Error ? error.message : 'cannot set up the device')
  }
  const iface = options.interface ?? 0
  const alternate = device.configuration?.interfaces.find(candidate => candidate.interfaceNumber === iface)?.alternate
  const packetSize = (direction: 'in' | 'out', number: number) => alternate?.endpoints.find(endpoint => endpoint.endpointNumber === number && endpoint.direction === direction)?.packetSize ?? 64
  const feed = new Feed(256)
  let closed = false

  const pump = async () => {
    if (options.in === undefined) return
    const size = packetSize('in', options.in)
    while (!closed) {
      try {
        const result = await device.transferIn(options.in, size)
        if (result.status === 'stall') { await device.clearHalt('in', options.in); continue }
        if (result.status === 'babble') continue
        if (result.data && result.data.byteLength) feed.push(new Uint8Array(result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength)))
      } catch (error) {
        if (!closed) session.emit?.('error', { message: error instanceof Error ? error.message : 'transfer failed' })
        break
      }
    }
    feed.end()
  }

  const onDisconnect = (event: Event) => {
    if ((event as USBConnectionEvent).device !== device) return
    session.emit?.('disconnect', null)
    closed = true
    feed.end()
  }
  const found = (globalThis as unknown as { navigator?: { usb?: Partial<EventTarget> } }).navigator?.usb
  const usb = typeof found?.addEventListener === 'function' ? found as EventTarget : undefined
  usb?.addEventListener('disconnect', onDisconnect)

  const session: DeviceSession = {
    info: {
      kind: 'usb', read: options.in !== undefined, write: options.out !== undefined,
      vendorId: device.vendorId, productId: device.productId, product: device.productName ?? '', manufacturer: device.manufacturerName ?? '', serial: device.serialNumber ?? '',
      ...(options.in !== undefined ? { in: options.in } : {}), ...(options.out !== undefined ? { out: options.out } : {}), interface: iface
    },
    ...(options.in !== undefined ? { read: () => feed.next() } : {}),
    ...(options.out !== undefined ? {
      async write(data: Uint8Array) {
        const size = packetSize('out', options.out!)
        for (let at = 0; at < data.length; at += Math.max(size, 4096)) {
          const result = await device.transferOut(options.out!, data.slice(at, at + Math.max(size, 4096)) as Uint8Array<ArrayBuffer>)
          if (result.status === 'stall') { await device.clearHalt('out', options.out!); throw new SessionError('EPIPE', 'the endpoint stalled') }
        }
      }
    } : {}),
    async control(op, args) {
      switch (op) {
        case 'info': return { configuration: device.configuration?.configurationValue ?? null, interface: iface, usbVersion: `${device.usbVersionMajor}.${device.usbVersionMinor}`, deviceClass: device.deviceClass, deviceSubclass: device.deviceSubclass, deviceProtocol: device.deviceProtocol, endpoints: (alternate?.endpoints ?? []).map(endpoint => ({ number: endpoint.endpointNumber, direction: endpoint.direction, type: endpoint.type, packetSize: endpoint.packetSize })) }
        case 'control-in': {
          const length = int(args[1], 65535)
          if (length === undefined) throw new SessionError('EINVAL', 'give the setup and the length to read')
          const result = await device.controlTransferIn(setupOf(args[0]), length)
          if (result.status !== 'ok') throw new SessionError('EPIPE', `control transfer ${result.status}`)
          const data = result.data
          return data ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : new Uint8Array(0)
        }
        case 'control-out': {
          const data = args[1] instanceof Uint8Array ? args[1] : undefined
          const result = await device.controlTransferOut(setupOf(args[0]), data as Uint8Array<ArrayBuffer> | undefined)
          if (result.status !== 'ok') throw new SessionError('EPIPE', `control transfer ${result.status}`)
          return result.bytesWritten
        }
        case 'clear-halt': {
          const direction = args[0]
          const number = int(args[1], 15)
          if ((direction !== 'in' && direction !== 'out') || number === undefined) throw new SessionError('EINVAL', 'give in or out, and the endpoint number')
          await device.clearHalt(direction, number)
          return null
        }
        case 'select-alt': {
          const alt = int(args[0], 255)
          if (alt === undefined) throw new SessionError('EINVAL', 'give the alternate setting')
          await device.selectAlternateInterface(iface, alt)
          return null
        }
        case 'reset': await device.reset(); return null
        default: throw new SessionError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
      }
    },
    async close() {
      if (closed && !device.opened) return
      closed = true
      usb?.removeEventListener('disconnect', onDisconnect)
      feed.end()
      await device.releaseInterface(iface).catch(() => {})
      await device.close().catch(() => {})
    }
  }
  void pump()
  return session
}
