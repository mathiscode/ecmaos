/**
 * What the machine's file systems hold in memory. The IndexedDB root, every `InMemory` mount (`/tmp`, `/media`, `/mnt`), and the
 * directories mounted through the browser's file APIs (OPFS, `webaccess`) all keep their files in RAM: the last two because their
 * backend copies the whole directory into a synchronous cache at mount time and writes through it. `df` shows the total so
 * "how full is the machine" is answerable, and the limits in `storage-limits.ts` apply to it.
 */

import { residentBytes } from './storage-limits.ts'

export interface HeldMount {
  path: string
  /** What holds it: the IndexedDB root, a plain memory file system, or the cache in front of a browser directory handle */
  kind: 'indexeddb' | 'memory' | 'directory-cache'
  bytes: number
}

interface MapStore extends Map<number, Uint8Array> { bytes?: number }

const isMap = (value: unknown): value is MapStore => value instanceof Map

const sumOf = (store: Map<number, Uint8Array>): number => {
  let bytes = 0
  for (const record of store.values()) bytes += record.byteLength
  return bytes
}

/** The memory one mounted file system holds, or `undefined` when it keeps nothing in memory (proc, sys, devices) */
export function heldBy(fs: unknown): Pick<HeldMount, 'kind' | 'bytes'> | undefined {
  const mount = (fs ?? {}) as { store?: unknown, _sync?: { store?: unknown } }
  const store = mount.store as { cache?: unknown } | undefined
  // the IndexedDB store keeps what it loaded in `cache`
  if (store && isMap(store.cache)) return { kind: 'indexeddb', bytes: residentBytes({ cache: store.cache }) }
  if (isMap(store)) return { kind: 'memory', bytes: typeof store.bytes === 'number' ? store.bytes : sumOf(store) }
  // an async backend (a browser directory) keeps its synchronous copy in a file system of its own
  const cached = mount._sync?.store
  if (isMap(cached)) return { kind: 'directory-cache', bytes: typeof cached.bytes === 'number' ? cached.bytes : sumOf(cached) }
  return undefined
}

/** Every mount that holds files in memory, with what it holds; `mounts` is zenfs's own mount table (path to file system) */
export function heldInMemory(mounts: Iterable<[string, unknown]>): HeldMount[] {
  const held: HeldMount[] = []
  for (const [path, fs] of mounts) {
    const one = heldBy(fs)
    if (one) held.push({ path, ...one })
  }
  return held.sort((a, b) => a.path.localeCompare(b.path))
}

export const totalHeld = (held: HeldMount[]): number => held.reduce((sum, item) => sum + item.bytes, 0)
