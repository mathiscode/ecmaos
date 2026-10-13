import { parse } from 'smol-toml'
import type { UsbSessionOptions } from './session.js'

export const CONFIG_PATH = '/etc/usb.toml'

const pick = (table: Record<string, unknown> | undefined): UsbSessionOptions => {
  const out: UsbSessionOptions = {}
  if (!table) return out
  for (const key of ['configuration', 'interface', 'in', 'out'] as const) {
    const value = table[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value
  }
  return out
}

/**
 * The stream settings for a device. Top-level keys apply to every device; a `[device."<vendor:product>"]` table (hex ids, as
 * `lsusb` prints them) or one named for the product overrides them. Without `in` and `out` the interface's first bulk or
 * interrupt endpoints are used. Unreadable text gives the defaults.
 *
 *     interface = 0
 *     [device."2341:0043"]
 *     in = 1
 *     out = 2
 */
export function usbOptionsFor(text: string | undefined, device: { vendorId: number, productId: number, productName?: string | null | undefined }): UsbSessionOptions {
  let doc: Record<string, unknown> = {}
  if (text) {
    try { doc = parse(text) } catch { /* a malformed file means the defaults */ }
  }
  const devices = (doc.device && typeof doc.device === 'object' ? doc.device : {}) as Record<string, Record<string, unknown>>
  const id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`
  const specific = devices[id] ?? (device.productName ? devices[device.productName] : undefined)
  return { auto: true, ...pick(doc), ...pick(specific) }
}
