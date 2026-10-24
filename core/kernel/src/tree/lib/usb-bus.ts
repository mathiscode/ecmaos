/**
 * `/sys/bus/usb/devices`: the USB devices the page knows of, for `lsusb`. A browser lists none on its own; a device is known once
 * the page has been granted it, and each package that is granted one (serial ports, HID devices, WebUSB devices) says which
 * it holds. The packages report the whole of their list each time, and a board that is a serial port and an HID device at once
 * is one entry here, as it is one device on a bus.
 */

import { BusType } from '@zenfs/linux/drivers/base/bus'
import { Device } from '@zenfs/linux'
import type { DeviceType } from '@zenfs/linux'
import type { KernelUsbDevice } from '@ecmaos/types'

interface Entry extends KernelUsbDevice {
  /** `bus-port`, as Linux names a device: bus 1, and the port is the number it was given */
  name: string
  number: number
  device: Device
}

const text = (show: () => string) => ({ mode: 0o444, show })
const hex4 = (value: number) => value.toString(16).padStart(4, '0')

const usbDevice: DeviceType = { name: 'usb_device', dev_attrs: {} }

/** What reading a device's `uevent` gives on Linux (here the file only takes writes), which `lsusb` reads its ids from */
const ueventOf = (entry: Entry) => [
  'DEVTYPE=usb_device',
  `PRODUCT=${entry.vendor.toString(16)}/${entry.product.toString(16)}/${(entry.version ?? 0).toString(16)}`,
  'TYPE=0/0/0',
  `BUSNUM=${'001'}`,
  `DEVNUM=${String(entry.number).padStart(3, '0')}`
].join('\n') + '\n'

/** Keeps `/sys/bus/usb/devices` in step with what the packages hold */
export class UsbRegistry {
  private readonly sources = new Map<string, KernelUsbDevice[]>()
  private readonly entries: Entry[] = []

  constructor(private readonly bus: BusType) {}

  /** Replaces the list `source` holds; devices that appeared are added, and ones no source holds any more are removed */
  sync(source: string, devices: KernelUsbDevice[]): void {
    this.sources.set(source, devices)

    // the merged view: the same ids and serial number from two sources are one device (serial ports know no serial number, so
    // they match the first device with their ids that has not been matched yet)
    const merged: KernelUsbDevice[] = []
    for (const list of this.sources.values()) {
      const matched = new Set<KernelUsbDevice>()
      for (const device of list) {
        const same = merged.find(other => !matched.has(other) && other.vendor === device.vendor && other.product === device.product && (!other.serial || !device.serial || other.serial === device.serial))
        if (same) {
          matched.add(same)
          same.manufacturer ??= device.manufacturer
          same.name ??= device.name
          same.serial ??= device.serial
          same.version ??= device.version
        } else {
          const added = { ...device }
          merged.push(added)
          matched.add(added)
        }
      }
    }

    // keep what is still there (so a device keeps its number), drop what went, add what is new
    const keep: Entry[] = []
    const fresh = [...merged]
    for (const entry of this.entries) {
      const index = fresh.findIndex(device => device.vendor === entry.vendor && device.product === entry.product && (!device.serial || !entry.serial || device.serial === entry.serial))
      if (index === -1) { try { entry.device.unregister() } catch { /* already gone */ } continue }
      Object.assign(entry, fresh[index])
      fresh.splice(index, 1)
      keep.push(entry)
    }
    for (const device of fresh) {
      let number = 1
      while (keep.some(entry => entry.number === number)) number++
      const name = `1-${number}`
      const entry = { ...device, name, number } as Entry
      entry.device = new Device({ name, bus: this.bus, type: usbDevice })
      entry.device.driver_data = entry
      entry.device.attrs = {
        idVendor: text(() => hex4(entry.vendor) + '\n'),
        idProduct: text(() => hex4(entry.product) + '\n'),
        bcdDevice: text(() => hex4(entry.version ?? 0) + '\n'),
        busnum: text(() => '1\n'),
        devnum: text(() => `${entry.number}\n`),
        manufacturer: text(() => (entry.manufacturer ?? '') + '\n'),
        product: text(() => (entry.name ?? '') + '\n'),
        serial: text(() => (entry.serial ?? '') + '\n')
      }
      entry.device.register()
      entry.device.kobject?.children.set('uevent', { name: 'uevent', mode: 0o444, show: () => ueventOf(entry) })
      keep.push(entry)
    }
    this.entries.length = 0
    this.entries.push(...keep.sort((a, b) => a.number - b.number))
  }
}
