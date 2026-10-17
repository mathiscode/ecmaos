import { ioctl } from '@zenfs/core'
import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { inputHub, WindowInputMinor } from '#lib/evdev.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** A pixel window has its own input device, fed by what the renderer reports about the window */
describe('/dev/input/event<2+N> of a framebuffer window', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  })

  it('carries pointer position, buttons, wheel, keys and focus, and goes with the window', async () => {
    const framebuffer = kernel.framebuffers.create({ width: 64, height: 48, title: 'input' })
    const node = `/dev/input/event${2 + framebuffer.index}`
    const minor = WindowInputMinor + framebuffer.index
    const stat = await kernel.filesystem.fs.stat(node)
    expect(stat.isCharacterDevice()).toBe(true)
    expect(Number(BigInt(stat.rdev) & 0xfffffn)).toBe(minor)

    const reading = kernel.shell.execute(`dd if=${node} bs=24 count=11 2> /dev/null | od -v -An -tu1 -w24 > /tmp/win-input.out`)
    for (let i = 0; i < 100 && !inputHub.listening(minor); i++) await new Promise(resolve => setTimeout(resolve, 20))
    const id = kernel.windows.list().find(w => w.title === 'input')!.id
    // a pointer at (10, 20), a left click, then a key press (3 events + sync each is 12 records with enter and focus)
    kernel.windows.reportInput(id, { k: 'enter' })
    kernel.windows.reportInput(id, { k: 'pointer', x: 10, y: 20 })
    kernel.windows.reportInput(id, { k: 'button', button: 0, down: true })
    kernel.windows.reportInput(id, { k: 'focus' })
    kernel.windows.reportInput(id, { k: 'key', code: 'KeyA', down: true })
    await reading
    const raw = await kernel.filesystem.fs.readFile('/tmp/win-input.out', 'utf-8')
    expect(raw.trim().split('\n').map(l => l.trim().split(/\s+/).length)).toEqual(Array(11).fill(24))
    const lines = raw.trim().split('\n').map(line => {
      const bytes = line.trim().split(/\s+/).map(Number)
      const view = new DataView(new Uint8Array(bytes).buffer)
      return [view.getUint16(16, true), view.getUint16(18, true), view.getInt32(20, true)]
    })
    expect(lines).toEqual([
      [4, 0x100, 1], [0, 0, 0],
      [3, 0, 10], [3, 1, 20], [0, 0, 0],
      [1, 0x110, 1], [0, 0, 0],
      [4, 0x101, 1], [0, 0, 0],
      [1, 30, 1], [0, 0, 0]
    ])

    const max = await ioctl(node, (2 << 30) | (24 << 16) | (0x45 << 8) | 0x40) as Uint8Array
    expect(new DataView(max.buffer, max.byteOffset).getInt32(8, true)).toBe(63)

    kernel.windows.close(id, true)
    await expect(kernel.filesystem.fs.stat(node)).rejects.toThrow()
  })
})
