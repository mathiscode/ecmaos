import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configure, fs, umount } from '@zenfs/core'
import { IndexedDB } from '@zenfs/dom'

import { rootWritesSettled } from '#filesystem.ts'

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
