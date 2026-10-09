import { describe, expect, it } from 'vitest'
import { configure, fs, InMemory, mounts } from '@zenfs/core'

import { heldBy, heldInMemory, totalHeld } from '#lib/memory-usage.ts'

describe('what file systems hold in memory', () => {
  it('counts a memory mount by the bytes of its records', async () => {
    await configure({ mounts: { '/': InMemory.create({}), '/scratch': InMemory.create({ label: 'scratch' }) } })
    const before = heldBy(mounts.get('/scratch'))!
    expect(before.kind).toBe('memory')
    fs.writeFileSync('/scratch/a', new Uint8Array(100_000))
    const after = heldBy(mounts.get('/scratch'))!
    expect(after.bytes - before.bytes).toBeGreaterThanOrEqual(100_000)
    expect(after.bytes - before.bytes).toBeLessThan(110_000)
    const held = heldInMemory(mounts)
    expect(held.map(item => item.path)).toEqual(['/', '/scratch'])
    expect(totalHeld(held)).toBe(held[0]!.bytes + held[1]!.bytes)
  })

  it('counts the IndexedDB store by its cache and a browser directory by the cache in front of it', () => {
    const records = new Map<number, Uint8Array>([[1, new Uint8Array(10)], [2, new Uint8Array(32)]])
    expect(heldBy({ store: { cache: records } })).toEqual({ kind: 'indexeddb', bytes: 42 })
    const cache = new Map<number, Uint8Array>([[1, new Uint8Array(7)]])
    expect(heldBy({ _sync: { store: cache } })).toEqual({ kind: 'directory-cache', bytes: 7 })
  })

  it('says nothing for a file system with no records of its own', () => {
    expect(heldBy({})).toBeUndefined()
    expect(heldBy(undefined)).toBeUndefined()
  })
})
