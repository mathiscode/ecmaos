import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ioctl } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { GL_DESTROY, GL_GETINFO, GL_RESIZE, GL_SWAP, GLCTL_CREATE, MaxGlContexts, destroyGlContext, glContextAt, setGlSurfaceFactory } from '#lib/gl.ts'

import { fakeGlSurfaces } from './fixtures/fake-gl'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const words = (...parts: Array<[number, 'f' | 'i' | 'u', number[]]>) => {
  const total = parts.reduce((sum, [, , values]) => sum + 1 + values.length, 0)
  const out = new Uint8Array(total * 4)
  const view = new DataView(out.buffer)
  let at = 0
  for (const [op, letter, values] of parts) {
    view.setUint32(at, ((op << 16) | values.length) >>> 0, true)
    at += 4
    for (const value of values) {
      if (letter === 'f') view.setFloat32(at, value, true)
      else if (letter === 'i') view.setInt32(at, value, true)
      else view.setUint32(at, value, true)
      at += 4
    }
  }
  return out
}
const size = (width: number, height: number) => words([0, 'u', [width, height]]).subarray(4)
const u32 = (bytes: Uint8Array, at = 0) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true)

describe('/dev/gl<N>', () => {
  let kernel: Kernel
  const { made: surfaces, factory } = fakeGlSurfaces()

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    setGlSurfaceFactory(factory)
  })

  afterEach(() => { for (let i = 0; i < MaxGlContexts; i++) destroyGlContext(i) })

  const create = async (width: number, height: number) => {
    const index = u32(await ioctl('/dev/glctl', GLCTL_CREATE, size(width, height)) as Uint8Array)
    return { index, path: `/dev/gl${index}` }
  }
  const frameOf = async (path: string) => {
    const handle = await kernel.filesystem.fs.open(path, 'r')
    try {
      const info = await ioctl(path, GL_GETINFO) as Uint8Array
      const out = new Uint8Array(u32(info, 0) * u32(info, 4) * 4)
      await handle.read(out, 0, out.length, null)
      return out
    } finally { await handle.close() }
  }

  it('has a control node on major 226 that makes a context and its node', async () => {
    const control = await kernel.filesystem.fs.stat('/dev/glctl')
    expect(control.isCharacterDevice()).toBe(true)
    expect(Number(BigInt(control.rdev) >> 20n)).toBe(226)
    const { index, path } = await create(4, 2)
    const stat = await kernel.filesystem.fs.stat(path)
    expect(Number(BigInt(stat.rdev) & 0xfffffn)).toBe(index)
    expect(u32(await ioctl(path, GL_GETINFO) as Uint8Array, 0)).toBe(4)
    destroyGlContext(index)
    await expect(kernel.filesystem.fs.stat(path)).rejects.toThrow()
  })

  it('draws the commands written to it and hands the picture back as blue-first pixels, top row first', async () => {
    const { path } = await create(3, 2)
    await kernel.filesystem.fs.writeFile(path, words([1, 'f', [1, 0.5, 0, 1]], [2, 'u', [0x4000]], [3, 'i', [0, 0, 3, 2]]))
    expect(surfaces.at(-1)!.viewports).toEqual([[0, 0, 3, 2]])
    expect(u32(await ioctl(path, GL_SWAP) as Uint8Array)).toBe(1)
    const frame = await frameOf(path)
    expect(frame.length).toBe(3 * 2 * 4)
    expect([...frame.subarray(0, 4)]).toEqual([0, 128, 255, 255])   // blue, green, red, opaque
  })

  it('flips the rows: GL reads from the bottom, the frame starts at the top', async () => {
    const { path } = await create(2, 3)
    const fake = surfaces.at(-1)!
    for (let row = 0; row < 3; row++) for (let x = 0; x < 2; x++) fake.buffer.set([row * 10, 0, 0, 255], (row * 2 + x) * 4)   // red is the row from the bottom
    await ioctl(path, GL_SWAP)
    const frame = await frameOf(path)
    expect([frame[2], frame[2 * 4 + 2], frame[4 * 4 + 2]]).toEqual([20, 10, 0])
  })

  it('waits for the rest of a command that was written in pieces, and refuses one it does not know', async () => {
    const { path } = await create(2, 2)
    const stream = words([1, 'f', [0, 1, 0, 1]], [2, 'u', [0x4000]])
    await kernel.filesystem.fs.writeFile(path, stream.subarray(0, 10))
    expect(surfaces.at(-1)!.color).toEqual([0, 0, 0, 0])
    await kernel.filesystem.fs.writeFile(path, stream.subarray(10))
    expect(surfaces.at(-1)!.color).toEqual([0, 1, 0, 1])
    await expect(kernel.filesystem.fs.writeFile(path, words([999, 'u', [1]]))).rejects.toThrow()
    expect(u32(await ioctl(path, GL_GETINFO) as Uint8Array, 12)).toBe(0x10000)
  })

  it('resizes, numbers contexts from the lowest free one, refuses a bad size and a full table', async () => {
    const a = await create(2, 2)
    const b = await create(2, 2)
    expect(b.index).toBe(a.index + 1)
    await ioctl(a.path, GL_RESIZE, size(5, 4))
    expect(glContextAt(a.index)!.frame.length).toBe(5 * 4 * 4)
    await expect(ioctl('/dev/glctl', GLCTL_CREATE, size(0, 4))).rejects.toThrow()
    await expect(ioctl('/dev/glctl', GLCTL_CREATE, size(9999, 4))).rejects.toThrow()
    await ioctl(a.path, GL_DESTROY)
    expect((await create(2, 2)).index).toBe(a.index)
    for (let i = 0; i < MaxGlContexts - 2; i++) await create(1, 1)
    await expect(ioctl('/dev/glctl', GLCTL_CREATE, size(1, 1))).rejects.toThrow()
  })
})
