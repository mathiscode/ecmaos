/**
 * The ioctls of a `/dev/hidraw<n>` node (`linux/hidraw.h`), answered from a HID session. The type is `'H'`; the number says
 * which, and for those that name a length (`HIDIOCGRAWNAME(len)`) the size field of the request is that length.
 */

import { withErrno } from 'kerium'
import type { DeviceSession } from '@ecmaos-devices/session'

export const HidType = 0x48 // 'H'

/** `BUS_USB`; a browser does not say whether a device is on USB or Bluetooth, and nearly all that WebHID lists are on USB */
const BUS_USB = 3
const HID_MAX_DESCRIPTOR_SIZE = 4096

const GRDESCSIZE = 1, GRDESC = 2, GRAWINFO = 3, GRAWNAME = 4, GRAWPHYS = 5, SFEATURE = 6, GFEATURE = 7, GRAWUNIQ = 8

export const hidrawRequest = (request: number) => ((request >>> 8) & 0xff) === HidType
const lengthOf = (request: number) => (request >>> 16) & 0x3fff

/** A string with its NUL, cut to `length`, as `HIDIOCGRAWNAME` and its kin give them */
const text = (value: string, length: number) => {
  const bytes = new TextEncoder().encode(value + '\0')
  const out = bytes.subarray(0, length)
  if (bytes.length > length && out.length) out[out.length - 1] = 0
  return out.slice()
}

/** The bytes of an ioctl's argument; from a program's worker they are a view of another realm's, which `instanceof` does not know */
const argument = (arg: unknown) => ArrayBuffer.isView(arg) ? new Uint8Array(arg.buffer, arg.byteOffset, arg.byteLength) : new Uint8Array(0)

/**
 * Answers `request` for the device behind `session`. Gives bytes for a request that reads, or a count for the one that writes
 * (`HIDIOCSFEATURE`, the number of bytes sent). A feature request's buffer begins with the report id, which is 0 on a
 * device with unnumbered reports; the data then follows.
 */
export async function hidrawIoctl(session: DeviceSession, request: number, arg: unknown): Promise<Uint8Array | number> {
  const number = request & 0xff
  const length = lengthOf(request)
  const info = session.info as { vendorId?: number, productId?: number, product?: string }
  switch (number) {
    case GRDESCSIZE: {
      const descriptor = await session.control!('descriptor', []) as Uint8Array
      const out = new Uint8Array(4)
      new DataView(out.buffer).setUint32(0, descriptor.length, true)
      return out
    }
    case GRDESC: {
      // struct hidraw_report_descriptor { __u32 size; __u8 value[HID_MAX_DESCRIPTOR_SIZE]; }
      const descriptor = await session.control!('descriptor', []) as Uint8Array
      if (descriptor.length > HID_MAX_DESCRIPTOR_SIZE) throw withErrno('EINVAL')
      const out = new Uint8Array(4 + HID_MAX_DESCRIPTOR_SIZE)
      new DataView(out.buffer).setUint32(0, descriptor.length, true)
      out.set(descriptor, 4)
      return out
    }
    case GRAWINFO: {
      // struct hidraw_devinfo { __u32 bustype; __s16 vendor; __s16 product; }
      const out = new Uint8Array(8)
      const view = new DataView(out.buffer)
      view.setUint32(0, BUS_USB, true)
      view.setInt16(4, (info.vendorId ?? 0) << 16 >> 16, true)
      view.setInt16(6, (info.productId ?? 0) << 16 >> 16, true)
      return out
    }
    case GRAWNAME: return text(info.product ?? '', length)
    case GRAWPHYS: return text(`webhid-${(info.vendorId ?? 0).toString(16).padStart(4, '0')}:${(info.productId ?? 0).toString(16).padStart(4, '0')}/input0`, length)
    case GRAWUNIQ: return text('', length)
    case SFEATURE: {
      const buffer = argument(arg)
      if (buffer.length < 1) throw withErrno('EINVAL')
      const count = Math.min(buffer.length, length || buffer.length)
      await session.control!('set-feature', [buffer[0]!, buffer.slice(1, count)])
      return count
    }
    case GFEATURE: {
      const buffer = argument(arg)
      if (buffer.length < 1) throw withErrno('EINVAL')
      const id = buffer[0]!
      const data = await session.control!('get-feature', [id]) as Uint8Array
      const out = new Uint8Array(Math.min(1 + data.length, length || buffer.length))
      out[0] = id
      out.set(data.subarray(0, out.length - 1), 1)
      return out
    }
    default: throw withErrno('ENOTTY')
  }
}
