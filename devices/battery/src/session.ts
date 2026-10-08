import { Feed, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession } from '@ecmaos-devices/session'

/** The level and charging state the Battery API reports; what `getBattery()` resolves to */
export interface BatteryLike extends EventTarget {
  level: number
  charging: boolean
  chargingTime: number
  dischargingTime: number
}

/**
 * The 18-byte record `/dev/battery` reads: level 0 to 100 (u8), charging 0 or 1 (u8), then the seconds to full and to empty
 * (float64, little endian; Infinity when unknown).
 */
export function batteryRecord(battery: BatteryLike): Uint8Array {
  const out = new Uint8Array(18)
  const view = new DataView(out.buffer)
  view.setUint8(0, Math.round(battery.level * 100))
  view.setUint8(1, Number(battery.charging))
  view.setFloat64(2, battery.chargingTime, true)
  view.setFloat64(10, battery.dischargingTime, true)
  return out
}

/** The battery as a device session: a record on open and another whenever anything in it changes. Read only. */
export async function openBatterySession(battery?: BatteryLike): Promise<DeviceSession> {
  const source = battery ?? await (globalThis as unknown as { navigator?: { getBattery?(): Promise<BatteryLike> } }).navigator?.getBattery?.()
  if (!source) throw new SessionError('ENODEV', 'this machine has no Battery API')
  const feed = new Feed(64)
  const report = () => feed.push(batteryRecord(source))
  const events = ['levelchange', 'chargingchange', 'chargingtimechange', 'dischargingtimechange']
  for (const name of events) source.addEventListener(name, report)
  report()
  return {
    info: { kind: 'battery', read: true, write: false, record: 18 },
    read: () => feed.next(),
    async control(op) {
      if (op !== 'status') throw new SessionError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
      return { level: source.level, charging: source.charging, chargingTime: Number.isFinite(source.chargingTime) ? source.chargingTime : null, dischargingTime: Number.isFinite(source.dischargingTime) ? source.dischargingTime : null }
    },
    close() {
      for (const name of events) source.removeEventListener(name, report)
      feed.end()
    }
  }
}
