import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * A real `emcc` build maps an unlinked temp file and a framebuffer. The shim has no way to share pages with the kernel, so
 * a mapping is a copy kept in step at syscalls (`wasi-preview1.mjs`, "mmap, by copying at syscalls").
 */
describe('mmap in an emcc program', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  })

  it('shares a temp file between the pointer and the descriptor, and draws into a framebuffer through a map', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/emcc-mmap.wasm`)
    await kernel.filesystem.fs.writeFile('/tmp/emcc-mmap', new Uint8Array(bytes), { mode: 0o755 })
    const framebuffer = kernel.framebuffers.create({ width: 8, height: 4, title: 'mmap' })

    const code = await kernel.shell.execute(`FB=${framebuffer.path} /tmp/emcc-mmap > /tmp/emcc-mmap.out 2>&1`)
    const out = await kernel.filesystem.fs.readFile('/tmp/emcc-mmap.out', 'utf8')
    expect({ code, out }).toEqual({ code: 0, out: expect.stringContaining('all ok') })
    expect(out).not.toContain('FAIL')
    expect(out).toContain('8x4 32bpp stride 32 len 128')
    expect(code).toBe(0)
    // 200 in the red byte of every pixel: blue first, then green, then red
    expect([...framebuffer.pixels.subarray(0, 8)]).toEqual([0, 0, 200, 0, 0, 0, 200, 0])
    expect(framebuffer.pixels.every((byte, index) => byte === (index % 4 === 2 ? 200 : 0))).toBe(true)
  })

  it('shows pixels drawn through a map by a program that only sleeps afterwards', async () => {
    const framebuffer = kernel.framebuffers.create({ width: 8, height: 4, title: 'mmap nosync' })
    const code = await kernel.shell.execute(`NOSYNC=1 FB=${framebuffer.path} /tmp/emcc-mmap > /tmp/emcc-mmap2.out 2>&1`)
    expect(code).toBe(0)
    expect(framebuffer.pixels.every((byte, index) => byte === (index % 4 === 2 ? 200 : 0))).toBe(true)
  })
})
