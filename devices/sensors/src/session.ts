import { Feed, jsonLine, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession } from '@ecmaos-devices/session'

/** What the Generic Sensor API gives, as far as this needs it */
interface SensorLike extends EventTarget {
  activated: boolean
  hasReading: boolean
  timestamp?: number | null
  start(): void
  stop(): void
  [key: string]: unknown
}
type SensorConstructor = new (options: { frequency: number }) => SensorLike

/** Names of the sensors that can be offered, the Generic Sensor class behind each, and the fields of a reading */
export const SensorKinds: Record<string, { cls: string, fields: string[], permissions: string[] }> = {
  accelerometer: { cls: 'Accelerometer', fields: ['x', 'y', 'z'], permissions: ['accelerometer'] },
  gyroscope: { cls: 'Gyroscope', fields: ['x', 'y', 'z'], permissions: ['gyroscope'] },
  magnetometer: { cls: 'Magnetometer', fields: ['x', 'y', 'z'], permissions: ['magnetometer'] },
  linear: { cls: 'LinearAccelerationSensor', fields: ['x', 'y', 'z'], permissions: ['accelerometer'] },
  gravity: { cls: 'GravitySensor', fields: ['x', 'y', 'z'], permissions: ['accelerometer'] },
  orientation: { cls: 'AbsoluteOrientationSensor', fields: ['quaternion'], permissions: ['accelerometer', 'magnetometer', 'gyroscope'] },
  light: { cls: 'AmbientLightSensor', fields: ['illuminance'], permissions: ['ambient-light-sensor'] }
}

export interface SensorSessionOptions {
  /** Readings per second; default 20, at most 60 */
  frequency?: number
  /** Where the sensor classes are found; default `globalThis` */
  scope?: Record<string, unknown>
  /** Skip the permission check (the host has no `navigator.permissions`) */
  permissions?: { query(descriptor: { name: string }): Promise<{ state: string }> }
}

/**
 * A motion or environment sensor as a device session: a JSON line `{"t":ms,"x":..,"y":..,"z":..}` (or `quaternion`, or
 * `illuminance`) for each reading. Read only; control `info` says what the sensor is.
 */
export async function openSensorSession(kind: string, options: SensorSessionOptions = {}): Promise<DeviceSession> {
  const spec = SensorKinds[kind]
  if (!spec) throw new SessionError('EINVAL', `unknown sensor '${kind.slice(0, 32)}' (use ${Object.keys(SensorKinds).join(', ')})`)
  const scope = options.scope ?? (globalThis as unknown as Record<string, unknown>)
  const cls = scope[spec.cls] as SensorConstructor | undefined
  if (!cls) throw new SessionError('ENODEV', `this machine has no ${kind} sensor`)
  const permissions = options.permissions ?? (globalThis as unknown as { navigator?: { permissions?: { query(descriptor: { name: string }): Promise<{ state: string }> } } }).navigator?.permissions
  if (permissions) {
    for (const name of spec.permissions) {
      const result = await permissions.query({ name })
      if (result.state !== 'granted') throw new SessionError('EACCES', `permission for ${name} is not granted`)
    }
  }
  const frequency = Math.max(1, Math.min(60, Math.round(options.frequency ?? 20)))
  const sensor = new cls({ frequency })
  const feed = new Feed(256)
  const onReading = () => {
    const out: Record<string, unknown> = { t: sensor.timestamp ?? Date.now() }
    for (const field of spec.fields) out[field] = sensor[field] ?? null
    feed.push(jsonLine(out))
  }
  const onError = (event: Event) => {
    const error = (event as unknown as { error?: { name?: string, message?: string } }).error
    session.emit?.('error', { name: error?.name ?? 'Error', message: error?.message ?? 'sensor error' })
    if (error?.name === 'NotAllowedError' || error?.name === 'NotReadableError') feed.end()
  }
  sensor.addEventListener('reading', onReading)
  sensor.addEventListener('error', onError)
  sensor.start()
  const session: DeviceSession = {
    info: { kind: 'sensor', sensor: kind, read: true, write: false, format: 'jsonl', frequency, fields: spec.fields },
    read: () => feed.next(),
    async control(op) {
      if (op === 'info') return { sensor: kind, frequency, activated: sensor.activated, hasReading: sensor.hasReading }
      throw new SessionError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
    },
    close() {
      sensor.removeEventListener('reading', onReading)
      sensor.removeEventListener('error', onError)
      try { sensor.stop() } catch { /* already stopped */ }
      feed.end()
    }
  }
  return session
}
