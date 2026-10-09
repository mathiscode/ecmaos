/**
 * Limits for the IndexedDB root, which is held whole in memory (every file costs its size in RAM and is one record, so changing it
 * rewrites all of it; measured in `.docs/STORAGE_MEASUREMENTS.md`). Without a limit a large file ends in a crashed or frozen tab;
 * with one it ends in an ordinary `EFBIG` from the write, and a log line says when the total in memory is getting large.
 */

import { withErrno } from 'kerium'

const MiB = 1024 * 1024

export interface StorageLimits {
  /** The most one file on the IndexedDB root may hold, in bytes; `false` for no limit */
  maxFileBytes: number | false
  /** Log a warning when everything the IndexedDB root holds in memory crosses this many bytes; `false` for never */
  warnResidentBytes: number | false
}

/**
 * What a device of `deviceMemoryGB` (as `navigator.deviceMemory` reports it, which browsers cap at 8) can be expected to carry:
 * a file of 512 MiB on a machine with 8 GB or more (1 GB was measured to work with 32 GB), less on smaller ones. The warning is at
 * twice that. Unknown memory is treated as 8.
 */
export function defaultStorageLimits(deviceMemoryGB?: number): StorageLimits {
  const gigabytes = deviceMemoryGB ?? 8
  const maxFileBytes = (gigabytes >= 8 ? 512 : gigabytes >= 4 ? 256 : gigabytes >= 2 ? 128 : 64) * MiB
  return { maxFileBytes, warnResidentBytes: maxFileBytes * 2 }
}

let limits: StorageLimits = defaultStorageLimits((globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory)
let warn: ((resident: number, threshold: number) => void) | undefined

/** Sets the limits (anything left out stays at the device default) and where the warning goes */
export function configureStorageLimits(next: Partial<StorageLimits> = {}, onWarning?: (resident: number, threshold: number) => void): StorageLimits {
  limits = { ...defaultStorageLimits((globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory), ...next }
  warn = onWarning
  return limits
}

export const currentStorageLimits = (): StorageLimits => limits

export const formatBytes = (bytes: number): string => bytes >= 1024 * MiB ? `${(bytes / (1024 * MiB)).toFixed(1)} GiB` : `${Math.round(bytes / MiB)} MiB`

/** Refuses a file that would hold `bytes`, as a write to a file system with no room for it does */
export function checkFileSize(bytes: number, path: string): void {
  if (limits.maxFileBytes === false || bytes <= limits.maxFileBytes) return
  throw withErrno('EFBIG', `${path}: ${formatBytes(bytes)} is over the ${formatBytes(limits.maxFileBytes)} limit for a file on this machine's storage, which is held in memory`)
}

interface Cached { cache: Map<number, Uint8Array> }
/** Keyed by the store's cache `Map` itself, which is the one object a store keeps for its whole life */
const meters = new WeakMap<object, { bytes: number, warned: boolean }>()

const sum = (store: Cached) => { let bytes = 0; for (const record of store.cache.values()) bytes += record.byteLength; return bytes }

/** Everything `store` holds in memory, in bytes */
export function residentBytes(store: Cached): number {
  return meters.get(store.cache)?.bytes ?? sum(store)
}

/** Call before a change to the store's records, so the total is known from before it */
export function meterStart(store: Cached): void {
  if (!meters.has(store.cache)) meters.set(store.cache, { bytes: sum(store), warned: false })
}

/** Call after a change that grew the records by `delta` bytes (negative for shrinking); warns when the total crosses the threshold */
export function meterChange(store: Cached, delta: number): void {
  const meter = meters.get(store.cache)
  if (!meter) return
  meter.bytes += delta
  const threshold = limits.warnResidentBytes
  if (threshold === false) return
  if (!meter.warned && meter.bytes >= threshold) {
    meter.warned = true
    warn?.(meter.bytes, threshold)
  } else if (meter.warned && meter.bytes < threshold * 0.9) meter.warned = false
}
