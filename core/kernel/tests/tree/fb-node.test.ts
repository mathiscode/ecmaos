import { beforeAll, describe, expect, it } from 'vitest'
import { ioctl } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import type { WindowId, WindowInfo, WindowReports, WindowRenderer } from '@ecmaos/types'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** A renderer with no DOM, like a host window: it keeps the content it is given */
class RecordingRenderer implements WindowRenderer {
  contents = new Map<WindowId, unknown[]>()
  supports() { return true }
  attach(_reports: WindowReports) {}
  create(info: WindowInfo) { this.contents.set(info.id, []) }
  update() {}
  close(id: WindowId) { this.contents.delete(id) }
  content(id: WindowId, content: unknown) { this.contents.get(id)?.push(content) }
}

describe('/dev/fb<N>', () => {
  let kernel: Kernel
  const renderer = new RecordingRenderer()

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    kernel.windows.registerRenderer(renderer)
  })

  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  it('has a node for a framebuffer on major 29, drawn in its window, and loses it with the window', async () => {
    const framebuffer = kernel.framebuffers.create({ width: 4, height: 2, title: 'test' })
    const fs = kernel.filesystem.fs
    const stat = await fs.stat(framebuffer.path)
    expect(stat.isCharacterDevice()).toBe(true)
    expect(Number(BigInt(stat.rdev) >> 20n)).toBe(29)
    expect(Number(BigInt(stat.rdev) & 0xfffffn)).toBe(framebuffer.index)

    await kernel.shell.execute(`printf 'ABCDEFGH' > ${framebuffer.path}`)
    expect(String.fromCharCode(...framebuffer.pixels.subarray(0, 8))).toBe('ABCDEFGH')
    await wait(60)
    const shown = [...renderer.contents.values()].flat().at(-1) as { pixels: { width: number, height: number, data: string } }
    expect([shown.pixels.width, shown.pixels.height]).toEqual([4, 2])
    expect(atob(shown.pixels.data).slice(0, 8)).toBe('ABCDEFGH')

    const info = await ioctl(framebuffer.path, 0x4600) as Uint8Array
    expect(new DataView(info.buffer, info.byteOffset).getUint32(0, true)).toBe(4)
    const fixed = await ioctl(framebuffer.path, 0x4602) as Uint8Array
    expect(new DataView(fixed.buffer, fixed.byteOffset).getUint32(44, true)).toBe(16)

    const window = kernel.windows.list().find(w => w.title === 'test')!
    kernel.windows.close(window.id, true)
    await expect(fs.stat(framebuffer.path)).rejects.toThrow()
    expect(kernel.framebuffers.get(framebuffer.index)).toBeUndefined()
  })

  it('numbers framebuffers from the lowest free one', async () => {
    const a = kernel.framebuffers.create({ width: 2, height: 2 })
    const b = kernel.framebuffers.create({ width: 2, height: 2 })
    expect(b.index).toBe(a.index + 1)
    for (const w of kernel.windows.list()) kernel.windows.close(w.id, true)
    const c = kernel.framebuffers.create({ width: 2, height: 2 })
    expect(c.index).toBe(a.index)
    for (const w of kernel.windows.list()) kernel.windows.close(w.id, true)
  })

  it('refuses a size that is not a screen', () => {
    expect(() => kernel.framebuffers.create({ width: 0, height: 10 })).toThrow()
    expect(() => kernel.framebuffers.create({ width: 5000, height: 10 })).toThrow()
  })

  it('fbwin opens a window and prints its device; dd seeks within it; closing the window ends fbwin', async () => {
    const running = kernel.shell.execute('fbwin -t viaCommand 4x2 > /tmp/fbwin.out')
    for (let i = 0; i < 200 && !kernel.framebuffers.list().length; i++) await wait(25)
    const [framebuffer] = kernel.framebuffers.list()
    expect(framebuffer).toBeDefined()
    await kernel.shell.execute(`printf 'WXYZ' | dd of=${framebuffer!.path} bs=1 seek=8 2> /dev/null`)
    expect(String.fromCharCode(...framebuffer!.pixels.subarray(8, 12))).toBe('WXYZ')
    expect([...framebuffer!.pixels.subarray(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(await kernel.filesystem.fs.readFile('/tmp/fbwin.out', 'utf-8')).toBe(`${framebuffer!.path}\n`)
    expect(kernel.windows.list().some(w => w.title === 'viaCommand')).toBe(true)
    kernel.windows.close(kernel.windows.list().find(w => w.title === 'viaCommand')!.id, true)
    await running
    expect(kernel.framebuffers.list()).toHaveLength(0)
  })
})
