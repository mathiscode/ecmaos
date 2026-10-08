import { afterEach, describe, expect, it } from 'vitest'

import { acquireMachineLock, claimMachine, machineLockName, stealMachineLock, waitForMachineLock } from '#lib/machine-lock.ts'
import type { MachineLock } from '#lib/machine-lock.ts'
import { fenceRootStore, rootStoreFenced, rootStoreName, rootWritesSettled } from '#filesystem.ts'
import { IndexedDB, InMemory } from '@zenfs/dom'

const locks = process.getBuiltinModule('node:worker_threads').locks as unknown as LockManager
let counter = 0
const store = () => `test-${process.pid}-${counter++}`
const held: MachineLock[] = []
afterEach(() => { for (const lock of held.splice(0)) lock.release() })
const keep = <T extends MachineLock | undefined>(lock: T) => { if (lock) held.push(lock); return lock }
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

describe('one tab per machine', () => {
  it('gives the machine to the first tab and says busy to the second', async () => {
    const name = store()
    expect(keep(await acquireMachineLock(locks, name))).toBeDefined()
    expect(await acquireMachineLock(locks, name)).toBeUndefined()
    expect(keep(await acquireMachineLock(locks, store()))).toBeDefined() // another machine is another lock
  })

  it('frees the machine when the holder lets go', async () => {
    const name = store()
    const first = (await acquireMachineLock(locks, name))!
    first.release()
    await tick()
    expect(keep(await acquireMachineLock(locks, name))).toBeDefined()
  })

  it('a waiting tab gets it when the holder lets go', async () => {
    const name = store()
    const first = (await acquireMachineLock(locks, name))!
    const waiting = waitForMachineLock(locks, name, new AbortController().signal)
    let got = false
    void waiting.then(lock => { got = !!keep(lock) })
    await tick()
    expect(got).toBe(false)
    first.release()
    await waiting
    expect(got).toBe(true)
  })

  it('a stolen machine tells the old holder it was evicted, and the thief holds it', async () => {
    const name = store()
    const first = keep((await acquireMachineLock(locks, name)))!
    let evicted = false
    void first.evicted.then(() => { evicted = true })
    const thief = keep(await stealMachineLock(locks, name))!
    await tick()
    expect(evicted).toBe(true)
    expect(await acquireMachineLock(locks, name)).toBeUndefined()
    thief.release()
    await tick()
    expect(keep(await acquireMachineLock(locks, name))).toBeDefined()
  })

  it('names the lock for the store', () => {
    expect(machineLockName('root')).toBe('ecmaos:machine:root')
  })
})

describe('claiming the machine from a tab', () => {
  const ui = () => {
    const seen = { shown: 0, closed: 0, takeOver: undefined as undefined | (() => void) }
    return { seen, ui: { busy: (takeOver: () => void) => { seen.shown++; seen.takeOver = takeOver; return { close: () => { seen.closed++ } } } } }
  }

  it('says nothing when the machine is free', async () => {
    const { seen, ui: notice } = ui()
    keep(await claimMachine(locks, store(), notice))
    expect(seen.shown).toBe(0)
  })

  it('shows the notice while busy and starts by itself when the other tab lets go', async () => {
    const name = store()
    const other = (await acquireMachineLock(locks, name))!
    const { seen, ui: notice } = ui()
    const claim = claimMachine(locks, name, notice)
    await tick()
    expect(seen.shown).toBe(1)
    other.release()
    keep(await claim)
    expect(seen.closed).toBe(1)
  })

  it('takes the machine when the user says so, evicting the other tab, and leaves no waiter behind', async () => {
    const name = store()
    const other = keep(await acquireMachineLock(locks, name))!
    let evicted = false
    void other.evicted.then(() => { evicted = true })
    const { seen, ui: notice } = ui()
    const claim = claimMachine(locks, name, notice)
    await tick()
    seen.takeOver!()
    const mine = keep(await claim)!
    await tick()
    expect(evicted).toBe(true)
    expect(seen.closed).toBe(1)
    // the abandoned queued request must not take the machine after this tab gives it up
    mine.release()
    await tick()
    expect(keep(await acquireMachineLock(locks, name))).toBeDefined()
  })
})

describe('the root store', () => {
  it('is a store only when the root is IndexedDB', () => {
    expect(rootStoreName({ mounts: { '/': { backend: IndexedDB, storeName: 'root' } } })).toBe('root')
    expect(rootStoreName({ mounts: { '/': { backend: IndexedDB } } })).toBe('zenfs')
    expect(rootStoreName({ mounts: { '/': { backend: InMemory, options: { name: 'x' } } } })).toBeUndefined()
    expect(rootStoreName({ mounts: {} })).toBeUndefined()
  })

  it('has nothing to wait for when no write is under way, and the fence starts open', async () => {
    expect(rootStoreFenced()).toBe(false)
    await rootWritesSettled(50)
  })
})

describe('the write fence', () => {
  it('stops writes to an IndexedDB store for good', async () => {
    const { IndexedDBTransaction } = await import('@zenfs/dom')
    const puts: number[] = []
    const fake = { store: { cache: new Map() }, _idb: { put: (_data: unknown, id: number) => { const request: { onsuccess?: () => void, result?: unknown } = {}; puts.push(id); queueMicrotask(() => request.onsuccess?.()); return request } } }
    const before = rootStoreFenced()
    expect(before).toBe(false)
    fenceRootStore()
    expect(rootStoreFenced()).toBe(true)
    await IndexedDBTransaction.prototype.set.call(fake as never, 7, new Uint8Array([1]))
    await IndexedDBTransaction.prototype.remove.call(fake as never, 7)
    expect(puts).toEqual([])
    expect(fake.store.cache.size).toBe(0)
  })
})
