/// <reference types="@types/web-bluetooth" />

import { Feed, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession, Plain } from '@ecmaos-devices/session'

export interface BluetoothSessionOptions {
  /** The service holding the two characteristics below (a UUID, or a name such as `battery_service`) */
  service?: string
  /** The characteristic whose notifications are the bytes read */
  notify?: string
  /** The characteristic the bytes written are sent to, in pieces no longer than `chunk` */
  write?: string
  /** Bytes per write to the characteristic; default 20, which every link can carry */
  chunk?: number
}

const text = (value: Plain | undefined): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined
const bytesOf = (view: DataView) => new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))

/**
 * A Bluetooth LE device, connected over GATT, as a device session. With a service and characteristics given it is a byte
 * stream of the kind the common serial-over-BLE services make (notifications are the reads, writes go to a characteristic).
 * Any characteristic of the device is also reachable by the controls `services`, `characteristics`, `read`, `write`,
 * `subscribe` and `unsubscribe`; what a subscription hears arrives as the event `notify` with `{characteristic, value}`.
 */
export async function openBluetoothSession(device: BluetoothDevice, options: BluetoothSessionOptions = {}): Promise<DeviceSession> {
  if (!device.gatt) throw new SessionError('ENOTSUP', 'this device has no GATT server')
  const server = await device.gatt.connect()
  const feed = new Feed(256)
  const chunk = Math.max(1, Math.min(512, options.chunk ?? 20))
  const subscriptions = new Map<string, { characteristic: BluetoothRemoteGATTCharacteristic, listener: (event: Event) => void }>()
  let streamIn: BluetoothRemoteGATTCharacteristic | undefined
  let streamOut: BluetoothRemoteGATTCharacteristic | undefined
  let streamListener: ((event: Event) => void) | undefined

  const characteristicOf = async (serviceName: string, name: string) => await (await server.getPrimaryService(serviceName)).getCharacteristic(name)

  try {
    if (options.notify || options.write) {
      if (!options.service) throw new SessionError('EINVAL', 'give the service of the characteristics')
      if (options.notify) {
        streamIn = await characteristicOf(options.service, options.notify)
        streamListener = event => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value
          if (value) feed.push(bytesOf(value))
        }
        streamIn.addEventListener('characteristicvaluechanged', streamListener)
        await streamIn.startNotifications()
      }
      if (options.write) streamOut = await characteristicOf(options.service, options.write)
    }
  } catch (error) {
    if (streamIn && streamListener) streamIn.removeEventListener('characteristicvaluechanged', streamListener)
    device.gatt.disconnect()
    throw error instanceof SessionError ? error : new SessionError('EIO', error instanceof Error ? error.message : 'cannot set up the device')
  }

  const onDisconnect = () => { session.emit?.('disconnect', null); feed.end() }
  device.addEventListener('gattserverdisconnected', onDisconnect)

  const session: DeviceSession = {
    info: { kind: 'bluetooth', read: !!streamIn, write: !!streamOut, name: device.name ?? '', id: device.id, ...(options.service ? { service: options.service } : {}) },
    ...(streamIn ? { read: () => feed.next() } : {}),
    ...(streamOut ? {
      async write(data: Uint8Array) {
        for (let at = 0; at < data.length; at += chunk) {
          const piece = data.slice(at, at + chunk)
          if (streamOut!.properties.writeWithoutResponse) await streamOut!.writeValueWithoutResponse(piece)
          else await streamOut!.writeValueWithResponse(piece)
        }
      }
    } : {}),
    async control(op, args) {
      const service = text(args[0])
      const name = text(args[1])
      switch (op) {
        case 'services': return (await server.getPrimaryServices()).map(found => found.uuid)
        case 'characteristics': {
          if (!service) throw new SessionError('EINVAL', 'give the service')
          const found = await (await server.getPrimaryService(service)).getCharacteristics()
          return found.map(characteristic => ({ uuid: characteristic.uuid, read: characteristic.properties.read, write: characteristic.properties.write, writeWithoutResponse: characteristic.properties.writeWithoutResponse, notify: characteristic.properties.notify, indicate: characteristic.properties.indicate }))
        }
        case 'read': {
          if (!service || !name) throw new SessionError('EINVAL', 'give the service and the characteristic')
          return bytesOf(await (await characteristicOf(service, name)).readValue())
        }
        case 'write': {
          if (!service || !name || !(args[2] instanceof Uint8Array)) throw new SessionError('EINVAL', 'give the service, the characteristic and the bytes')
          const characteristic = await characteristicOf(service, name)
          await characteristic.writeValueWithResponse(args[2] as Uint8Array<ArrayBuffer>)
          return null
        }
        case 'subscribe': {
          if (!service || !name) throw new SessionError('EINVAL', 'give the service and the characteristic')
          const key = `${service}/${name}`
          if (subscriptions.has(key)) return null
          if (subscriptions.size >= 16) throw new SessionError('EMFILE', 'too many subscriptions')
          const characteristic = await characteristicOf(service, name)
          const listener = (event: Event) => {
            const value = (event.target as BluetoothRemoteGATTCharacteristic).value
            if (value) session.emit?.('notify', { characteristic: name, value: bytesOf(value) })
          }
          characteristic.addEventListener('characteristicvaluechanged', listener)
          subscriptions.set(key, { characteristic, listener })
          await characteristic.startNotifications()
          return null
        }
        case 'unsubscribe': {
          if (!service || !name) throw new SessionError('EINVAL', 'give the service and the characteristic')
          const key = `${service}/${name}`
          const found = subscriptions.get(key)
          if (!found) return null
          subscriptions.delete(key)
          found.characteristic.removeEventListener('characteristicvaluechanged', found.listener)
          await found.characteristic.stopNotifications().catch(() => {})
          return null
        }
        default: throw new SessionError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
      }
    },
    close() {
      device.removeEventListener('gattserverdisconnected', onDisconnect)
      for (const { characteristic, listener } of subscriptions.values()) characteristic.removeEventListener('characteristicvaluechanged', listener)
      subscriptions.clear()
      if (streamIn && streamListener) streamIn.removeEventListener('characteristicvaluechanged', streamListener)
      feed.end()
      if (device.gatt?.connected) device.gatt.disconnect()
    }
  }
  return session
}
