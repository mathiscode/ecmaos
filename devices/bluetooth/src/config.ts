import { parse } from 'smol-toml'
import type { BluetoothSessionOptions } from './session.js'

/** Nordic UART Service, which most serial-over-BLE modules (nRF, Adafruit Bluefruit, many ESP32 sketches) speak */
export const NORDIC_UART: Required<Pick<BluetoothSessionOptions, 'service' | 'notify' | 'write'>> = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e'
}

export const CONFIG_PATH = '/etc/bluetooth.toml'

const pick = (table: Record<string, unknown> | undefined): BluetoothSessionOptions => {
  const out: BluetoothSessionOptions = {}
  if (!table) return out
  if (typeof table.service === 'string') out.service = table.service
  if (typeof table.notify === 'string') out.notify = table.notify
  if (typeof table.write === 'string') out.write = table.write
  if (typeof table.chunk === 'number') out.chunk = table.chunk
  return out
}

/**
 * The stream settings for a device. Top-level keys apply to every device; a `[device."<name or id>"]` table overrides them
 * for the device with that name or id. Anything not set falls back to the Nordic UART service. Unreadable text gives the
 * defaults.
 *
 *     service = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
 *     [device."HM-10"]
 *     service = "ffe0"
 *     notify = "ffe1"
 *     write = "ffe1"
 */
export function bluetoothOptionsFor(text: string | undefined, device: { name?: string, id: string }): BluetoothSessionOptions {
  let doc: Record<string, unknown> = {}
  if (text) {
    try { doc = parse(text) } catch { /* a malformed file means the defaults */ }
  }
  const devices = (doc.device && typeof doc.device === 'object' ? doc.device : {}) as Record<string, Record<string, unknown>>
  const specific = (device.name && devices[device.name]) || devices[device.id]
  return { ...NORDIC_UART, ...pick(doc), ...pick(specific) }
}
