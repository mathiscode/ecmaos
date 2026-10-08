/// <reference types="w3c-web-hid" />

/**
 * A WebHID device as a device session. Each input report is one read chunk: the report id (0 when the device has none)
 * then the report's data. A write is the same shape, sent as an output report. Controls: `get-feature`, `set-feature`
 * and `collections`.
 */

import { Feed, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession, Plain } from '@ecmaos-devices/session'

export type HidDeviceSession = DeviceSession
export { SessionError as HidError }
const HidError = SessionError

const isReportId = (value: Plain | undefined): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255

/** Opens `device` (one the user has already given this page, see `hid request`) and serves it */
export async function openHidSession(device: HIDDevice): Promise<HidDeviceSession> {
  await device.open()
  const feed = new Feed(1024)

  const onReport = (event: Event) => {
    const { reportId, data } = event as HIDInputReportEvent
    const chunk = new Uint8Array(1 + data.byteLength)
    chunk[0] = reportId
    chunk.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 1)
    feed.push(chunk)
  }
  const finish = () => feed.end()
  const found = (globalThis as { navigator?: { hid?: Partial<EventTarget> } }).navigator?.hid
  const hid = typeof found?.addEventListener === 'function' ? found as EventTarget : undefined
  const onDisconnect = (event: Event) => {
    if ((event as HIDConnectionEvent).device !== device) return
    session.emit?.('disconnect', null)
    finish()
  }
  device.addEventListener('inputreport', onReport)
  hid?.addEventListener('disconnect', onDisconnect)

  const session: HidDeviceSession = {
    info: { kind: 'hid', read: true, write: true, vendorId: device.vendorId, productId: device.productId, product: device.productName ?? '' },
    read: () => feed.next(),
    async write(data) {
      if (data.length < 1) return
      await device.sendReport(data[0]!, data.slice(1) as Uint8Array<ArrayBuffer>)
    },
    async control(op, args) {
      switch (op) {
        case 'get-feature': {
          if (!isReportId(args[0])) throw new HidError('EINVAL', 'give the report id')
          const view = await device.receiveFeatureReport(args[0])
          return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
        }
        case 'set-feature': {
          if (!isReportId(args[0]) || !(args[1] instanceof Uint8Array)) throw new HidError('EINVAL', 'give the report id and its bytes')
          await device.sendFeatureReport(args[0], args[1] as Uint8Array<ArrayBuffer>)
          return null
        }
        case 'collections': return JSON.parse(JSON.stringify(device.collections)) as Plain
        default: throw new HidError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
      }
    },
    async close() {
            device.removeEventListener('inputreport', onReport)
      hid?.removeEventListener('disconnect', onDisconnect)
      finish()
      await device.close().catch(() => {})
    }
  }
  return session
}
