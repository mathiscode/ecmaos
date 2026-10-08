import { Feed, jsonLine, SessionError } from '@ecmaos-devices/session'
import type { DeviceSession } from '@ecmaos-devices/session'

/** Where the machine is. A JSON line is `{"t":ms,"latitude":..,"longitude":..,"accuracy":..,"altitude":..,"altitudeAccuracy":..,"heading":..,"speed":..}`. */
interface Position { timestamp: number, coords: { latitude: number, longitude: number, accuracy: number, altitude: number | null, altitudeAccuracy: number | null, heading: number | null, speed: number | null } }
interface GeolocationLike {
  watchPosition(ok: (position: Position) => void, fail: (error: { code: number, message: string }) => void, options?: object): number
  clearWatch(id: number): void
  getCurrentPosition(ok: (position: Position) => void, fail: (error: { code: number, message: string }) => void, options?: object): void
}

const reading = (position: Position) => ({ t: position.timestamp, latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, altitude: position.coords.altitude, altitudeAccuracy: position.coords.altitudeAccuracy, heading: position.coords.heading, speed: position.coords.speed })
const refusal = (error: { code: number, message: string }) => new SessionError(error.code === 1 ? 'EACCES' : error.code === 3 ? 'ETIMEDOUT' : 'EIO', error.message)

/** Geolocation as a device session: a JSON line for each change in position. Read only; control `position` asks for one fix. */
export async function openGeoSession(geolocation?: GeolocationLike): Promise<DeviceSession> {
  const source = geolocation ?? (globalThis as unknown as { navigator?: { geolocation?: GeolocationLike } }).navigator?.geolocation
  if (!source) throw new SessionError('ENODEV', 'this machine has no geolocation')
  const feed = new Feed(256)
  let failure: SessionError | undefined
  const watch = source.watchPosition(position => feed.push(jsonLine(reading(position))), error => {
    failure = refusal(error)
    // A permission refusal ends the stream; a lost fix may come back, so it is only reported
    if (error.code === 1) feed.end()
    else session.emit?.('error', { code: failure.code, message: failure.message })
  })
  const session: DeviceSession = {
    info: { kind: 'geo', read: true, write: false, format: 'jsonl' },
    read: () => feed.next(),
    async control(op) {
      if (op !== 'position') throw new SessionError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
      return await new Promise((resolve, reject) => source.getCurrentPosition(position => resolve(reading(position)), error => reject(refusal(error))))
    },
    close() { source.clearWatch(watch); feed.end() }
  }
  return session
}
