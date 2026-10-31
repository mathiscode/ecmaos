import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configure, fs, umount } from '@zenfs/core'
import { IndexedDB } from '@zenfs/dom'

import { DeferMs, flushDeferredWrites, measureOwnedBytes, rootWritesSettled } from '#filesystem.ts'
import { configureQuotas } from '#lib/quota.ts'
import { configureStorageLimits } from '#lib/storage-limits.ts'

/**
 * The root filesystem is a zenfs StoreFS over IndexedDB. These run the real backend (on fake-indexeddb) with the kernel's patches
 * loaded, because a store that mishandles partial writes loses data without any error: a chunk written at an offset replaced the
 * whole file, on disk and in the cache, and nothing in a test on an in-memory root could ever see it.
 */
const text = (bytes: Uint8Array | Buffer) => new TextDecoder().decode(bytes)
const mount = async (name: string) => { await configure({ mounts: { '/': { backend: IndexedDB, storeName: name } as never } }) }

describe('the IndexedDB root keeps what is written into the middle and the end of a file', () => {
  const store = `idb-root-${process.pid}`

  beforeAll(async () => { await mount(store) })
  afterAll(async () => { try { umount('/') } catch { /* nothing mounted */ } })

  it('appends to an existing file', async () => {
    await fs.promises.writeFile('/a.txt', 'hello world')
    await fs.promises.appendFile('/a.txt', '!!!')
    expect(text(await fs.promises.readFile('/a.txt'))).toBe('hello world!!!')
  })

  it('writes into the middle of an existing file through a handle', async () => {
    await fs.promises.writeFile('/b.txt', '0123456789')
    const handle = await fs.promises.open('/b.txt', 'r+')
    await handle.write(new TextEncoder().encode('XY'), 0, 2, 4)
    await handle.close()
    expect(text(await fs.promises.readFile('/b.txt'))).toBe('0123XY6789')
  })

  it('writes one byte at the start of a larger file', async () => {
    await fs.promises.writeFile('/c.bin', new Uint8Array(100_000).fill(7))
    const handle = await fs.promises.open('/c.bin', 'r+')
    await handle.write(new Uint8Array([9]), 0, 1, 0)
    await handle.close()
    const data = await fs.promises.readFile('/c.bin')
    expect(data.length).toBe(100_000)
    expect([data[0], data[1], data[99_999]]).toEqual([9, 7, 7])
  })

  it('reads positions other than the start', async () => {
    const data = new Uint8Array(70_000)
    for (let i = 0; i < data.length; i++) data[i] = i & 255
    await fs.promises.writeFile('/d.bin', data)
    const handle = await fs.promises.open('/d.bin', 'r')
    const window = new Uint8Array(64)
    await handle.read(window, 0, 64, 5000)
    await handle.close()
    expect(Array.from(window.slice(0, 4))).toEqual([5000 & 255, 5001 & 255, 5002 & 255, 5003 & 255])
  })

  it('shrinks and grows again without bringing the old bytes back', async () => {
    await fs.promises.writeFile('/e.txt', 'abcdefghij')
    await fs.promises.truncate('/e.txt', 3)
    await fs.promises.truncate('/e.txt', 8)
    expect(Array.from(await fs.promises.readFile('/e.txt'))).toEqual([97, 98, 99, 0, 0, 0, 0, 0])
  })

  it('has it all still there after the store is loaded again', async () => {
    await rootWritesSettled(5000)
    umount('/')
    await mount(store)
    expect(text(await fs.promises.readFile('/a.txt'))).toBe('hello world!!!')
    expect(text(await fs.promises.readFile('/b.txt'))).toBe('0123XY6789')
    const c = await fs.promises.readFile('/c.bin')
    expect([c.length, c[0], c[50_000]]).toEqual([100_000, 9, 7])
  })
})

describe('limits on a root that is held in memory', () => {
  const store = `idb-limits-${process.pid}`
  const warnings: Array<[number, number]> = []

  beforeAll(async () => {
    configureStorageLimits({ maxFileBytes: 1 << 20, warnResidentBytes: 3 << 20 }, (resident, threshold) => warnings.push([resident, threshold]))
    await mount(store)
  })
  afterAll(async () => {
    configureStorageLimits({ maxFileBytes: false, warnResidentBytes: false })
    try { umount('/') } catch { /* nothing mounted */ }
  })

  const failure = async (run: () => Promise<unknown>) => { try { await run() } catch (error) { return error as { code?: string, message: string } } return undefined }

  it('takes a file up to the limit and refuses one past it with EFBIG, leaving nothing behind', async () => {
    await fs.promises.writeFile('/ok.bin', new Uint8Array(1 << 20))
    const error = await failure(() => fs.promises.writeFile('/too-big.bin', new Uint8Array((1 << 20) + 1)))
    expect(error?.code).toBe('EFBIG')
    expect(error?.message).toMatch(/over the 1 MiB limit/)
    expect(await fs.promises.readFile('/ok.bin').then(data => data.length)).toBe(1 << 20)
    expect((await fs.promises.readFile('/too-big.bin').catch(() => undefined))?.length ?? 0).toBe(0)
  })

  it('refuses to grow an existing file past it, and the file keeps what it had', async () => {
    await fs.promises.writeFile('/grow.txt', 'small')
    expect((await failure(() => fs.promises.appendFile('/grow.txt', new Uint8Array(1 << 20))))?.code).toBe('EFBIG')
    expect((await failure(() => fs.promises.truncate('/grow.txt', (1 << 20) + 5)))?.code).toBe('EFBIG')
    expect(text(await fs.promises.readFile('/grow.txt'))).toBe('small')
    // a refusal is not a broken store: the file can still be written
    await fs.promises.appendFile('/grow.txt', '!')
    expect(text(await fs.promises.readFile('/grow.txt'))).toBe('small!')
  })

  it('refuses the same through a handle, at the write, and the handle closes cleanly', async () => {
    const handle = await fs.promises.open('/handle.bin', 'w')
    await handle.write(new TextEncoder().encode('fine'), 0, 4, 0)
    expect((await failure(() => handle.write(new Uint8Array((1 << 20) + 10), 0, (1 << 20) + 10, 0)))?.code).toBe('EFBIG')
    await handle.close()
    expect(text(await fs.promises.readFile('/handle.bin'))).toBe('fine')
  })

  it('warns once when what is held in memory crosses the threshold, and again after dropping below it', async () => {
    warnings.length = 0
    for (let i = 0; i < 4; i++) await fs.promises.writeFile(`/fill-${i}.bin`, new Uint8Array(900 * 1024))
    expect(warnings.length).toBe(1)
    expect(warnings[0]![0]).toBeGreaterThanOrEqual(3 << 20)
    expect(warnings[0]![1]).toBe(3 << 20)
    for (let i = 0; i < 4; i++) await fs.promises.unlink(`/fill-${i}.bin`)
    await fs.promises.unlink('/ok.bin')
    for (let i = 0; i < 4; i++) await fs.promises.writeFile(`/fill-${i}.bin`, new Uint8Array(900 * 1024))
    expect(warnings.length).toBe(2)
  })

  it('with the limits off, nothing is refused', async () => {
    configureStorageLimits({ maxFileBytes: false, warnResidentBytes: false })
    await fs.promises.writeFile('/free.bin', new Uint8Array((1 << 20) * 3))
    expect((await fs.promises.stat('/free.bin')).size).toBe((1 << 20) * 3)
  })
})


describe('writes to a large record are merged', () => {
  const store = `idb-defer-${process.pid}`
  const puts: number[] = []
  const realPut = IDBObjectStore.prototype.put

  beforeAll(async () => {
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      puts.push((value as Uint8Array).byteLength)
      return realPut.call(this, value, key)
    }
    await mount(store)
  })
  afterAll(async () => {
    IDBObjectStore.prototype.put = realPut
    try { umount('/') } catch { /* nothing mounted */ }
  })

  const bigPuts = () => puts.filter(size => size >= 300_000).length

  it('writes a big file once for many appends, and the file reads back whole at every step', async () => {
    await fs.promises.writeFile('/log', new Uint8Array(300_000).fill(1))
    await rootWritesSettled(5000)
    const before = bigPuts()
    for (let i = 0; i < 20; i++) {
      await fs.promises.appendFile('/log', 'x')
      expect((await fs.promises.readFile('/log')).length).toBe(300_001 + i)
    }
    await rootWritesSettled(5000)
    // 20 appends, merged: far fewer writes of the whole record than appends (one per merge window)
    expect(bigPuts() - before).toBeLessThan(10)
    expect(bigPuts() - before).toBeGreaterThanOrEqual(1)
  })

  it('has the last bytes after the store is loaded again', async () => {
    await fs.promises.appendFile('/log', 'END')
    await rootWritesSettled(5000)
    umount('/')
    await mount(store)
    const data = await fs.promises.readFile('/log')
    expect(data.length).toBe(300_000 + 20 + 3)
    expect(text(data.slice(-3))).toBe('END')
  })

  it('does not bring a removed file back, and a file that shrank below the threshold keeps its new size', async () => {
    await fs.promises.writeFile('/gone', new Uint8Array(400_000))
    await fs.promises.unlink('/gone')
    await fs.promises.writeFile('/shrinks', new Uint8Array(400_000))
    await fs.promises.writeFile('/shrinks', 'tiny')
    await rootWritesSettled(5000)
    umount('/')
    await mount(store)
    expect(await fs.promises.exists('/gone')).toBe(false)
    expect(text(await fs.promises.readFile('/shrinks'))).toBe('tiny')
  })

  it('writes at once when asked to flush, without waiting for the window', async () => {
    await fs.promises.writeFile('/flush', new Uint8Array(500_000))
    const before = bigPuts()
    await flushDeferredWrites()
    expect(bigPuts()).toBeGreaterThan(before)
    expect(DeferMs).toBeGreaterThan(0)
  })
})


describe('a storage quota on the IndexedDB root', () => {
  const store = `idb-quota-${process.pid}`
  beforeAll(async () => { await mount(store); await fs.promises.mkdir('/q'); configureQuotas(new Map([[1000, 1_000_000]]), measureOwnedBytes) })
  afterAll(async () => { configureQuotas(new Map()); try { umount('/') } catch { /* nothing mounted */ } })

  const owned = async (path: string, size: number) => {
    await fs.promises.writeFile(path, new Uint8Array(size))
    await fs.promises.chown(path, 1000, 1000)
  }

  it('refuses a write that would take the owner past the quota with EDQUOT, leaving the file as it was', async () => {
    await owned('/q/a', 600_000)
    const error = await fs.promises.appendFile('/q/a', new Uint8Array(500_000)).catch(failure => failure)
    expect((error as { code?: string }).code).toBe('EDQUOT')
    expect((await fs.promises.stat('/q/a')).size).toBe(600_000)
    // a write that fits is still fine, and so is another user's file
    await fs.promises.appendFile('/q/a', new Uint8Array(300_000))
    await fs.promises.writeFile('/q/root-owned', new Uint8Array(5_000_000))
  })

  it('counts a truncate that grows a file, and finds the space again after files are deleted', async () => {
    expect((await fs.promises.truncate('/q/a', 2_000_000).catch(failure => failure) as { code?: string }).code).toBe('EDQUOT')
    await owned('/q/b', 90_000)
    await fs.promises.unlink('/q/b')
    await fs.promises.unlink('/q/a')
    await owned('/q/c', 900_000)
    await fs.promises.appendFile('/q/c', new Uint8Array(50_000))
    expect((await fs.promises.stat('/q/c')).size).toBe(950_000)
  })
})

describe('reads the cache answers do not open an IndexedDB transaction', () => {
  const store = `idb-lazy-${process.pid}`
  const opened = () => {
    const original = IDBDatabase.prototype.transaction
    let count = 0
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) { count++; return original.apply(this, args) } as typeof original
    return { count: () => count, restore: () => { IDBDatabase.prototype.transaction = original } }
  }

  beforeAll(async () => { await mount(store); await fs.promises.mkdir('/a/b/c', { recursive: true }); await fs.promises.writeFile('/a/b/c/file', 'kept') })
  afterAll(async () => { try { umount('/') } catch { /* nothing mounted */ } })

  it('resolves and stats a path without one, however often (an install does it hundreds of thousands of times)', () => {
    const spy = opened()
    try {
      for (let i = 0; i < 200; i++) { fs.statSync('/a/b/c/file'); fs.existsSync('/a/b/c/missing') }
      expect(spy.count()).toBe(0)
    } finally { spy.restore() }
  })

  it('still opens one for a write, which reaches the store and is there after it is loaded again', async () => {
    const spy = opened()
    try {
      await fs.promises.writeFile('/a/b/c/second', 'written')
      expect(spy.count()).toBeGreaterThan(0)
    } finally { spy.restore() }
    await rootWritesSettled()
    umount('/')
    await mount(store)
    expect(text(await fs.promises.readFile('/a/b/c/second'))).toBe('written')
    expect(text(await fs.promises.readFile('/a/b/c/file'))).toBe('kept')
  })
})
