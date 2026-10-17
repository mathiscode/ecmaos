import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Framebuffer, FixScreenInfoSize, VarScreenInfoSize, windowSink } from '#lib/fb.ts'
import type { PixelFrame } from '#lib/fb.ts'

const u32 = (bytes: Uint8Array, index: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(index * 4, true)

describe('Framebuffer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const make = () => {
    const frames: PixelFrame[] = []
    const framebuffer = new Framebuffer(3, 4, 2, frame => frames.push({ ...frame, data: frame.data.slice() }))
    return { framebuffer, frames }
  }

  it('keeps writes in order at the cursor, cuts the last one short and then refuses', () => {
    const { framebuffer } = make()
    expect(framebuffer.size).toBe(32)
    expect(framebuffer.write(new Uint8Array(20).fill(1))).toBe(20)
    expect(framebuffer.write(new Uint8Array(20).fill(2))).toBe(12)
    expect(() => framebuffer.write(new Uint8Array(1))).toThrow(/ENOSPC|no space/i)
    expect([...framebuffer.pixels.subarray(18, 22)]).toEqual([1, 1, 2, 2])
  })

  it('seeks like lseek and reads from there', () => {
    const { framebuffer } = make()
    framebuffer.write(Uint8Array.from({ length: 32 }, (_, i) => i))
    expect(framebuffer.seek(8, 0)).toBe(8)
    expect(framebuffer.seek(4, 1)).toBe(12)
    expect(framebuffer.seek(-4, 2)).toBe(28)
    const into = new Uint8Array(8)
    expect(framebuffer.read(into)).toBe(4)
    expect([...into.subarray(0, 4)]).toEqual([28, 29, 30, 31])
    expect(framebuffer.read(into)).toBe(0)
    expect(() => framebuffer.seek(-1, 0)).toThrow()
    expect(() => framebuffer.seek(0, 9)).toThrow()
  })

  it('shows changes made together as one frame, soon', () => {
    const { framebuffer, frames } = make()
    framebuffer.write(new Uint8Array(4).fill(9))
    framebuffer.write(new Uint8Array(4).fill(8))
    expect(frames).toHaveLength(0)
    vi.advanceTimersByTime(20)
    expect(frames).toHaveLength(1)
    expect([...frames[0]!.data.subarray(0, 8)]).toEqual([9, 9, 9, 9, 8, 8, 8, 8])
    expect([frames[0]!.width, frames[0]!.height]).toEqual([4, 2])
  })

  it('stops after close', () => {
    const { framebuffer, frames } = make()
    framebuffer.write(new Uint8Array(4))
    framebuffer.close()
    vi.advanceTimersByTime(50)
    expect(frames).toHaveLength(0)
    expect(() => framebuffer.write(new Uint8Array(1))).toThrow()
  })

  it('describes its screen as fbdev does: 32 bits, blue in the low byte', () => {
    const { framebuffer } = make()
    const variable = framebuffer.varScreenInfo()
    expect(variable.length).toBe(VarScreenInfoSize)
    expect([u32(variable, 0), u32(variable, 1), u32(variable, 2), u32(variable, 3), u32(variable, 6)]).toEqual([4, 2, 4, 2, 32])
    expect([u32(variable, 8), u32(variable, 9), u32(variable, 11), u32(variable, 12), u32(variable, 14), u32(variable, 15)]).toEqual([16, 8, 8, 8, 0, 8])
    const fixed = framebuffer.fixScreenInfo()
    expect(fixed.length).toBe(FixScreenInfoSize)
    expect(new TextDecoder().decode(fixed.subarray(0, 9))).toBe('ecmaOS fb')
    expect([u32(fixed, 5), u32(fixed, 8), u32(fixed, 11)]).toEqual([32, 2, 16])
  })

  it('accepts the mode it is in and no other', () => {
    const { framebuffer } = make()
    expect(framebuffer.accepts(framebuffer.varScreenInfo())).toBe(true)
    const other = framebuffer.varScreenInfo()
    new DataView(other.buffer).setUint32(0, 640, true)
    expect(framebuffer.accepts(other)).toBe(false)
    expect(framebuffer.accepts(new Uint8Array(4))).toBe(false)
  })
})

describe('windowSink', () => {
  it('sends a window with no DOM the frame as its content, blue first, in base64', () => {
    const set: unknown[] = []
    const window = { get body(): HTMLElement { throw new Error('no body') }, setContent: (content: unknown) => set.push(content) }
    windowSink(window as never)({ width: 1, height: 1, data: Uint8Array.from([1, 2, 3, 0]) })
    expect(set).toEqual([{ pixels: { width: 1, height: 1, data: btoa('\x01\x02\x03\x00') } }])
  })

  it('draws a window with a body in a canvas of the frame size', () => {
    const body = document.createElement('div')
    document.body.append(body)
    windowSink({ body, setContent: () => { throw new Error('unused') } } as never)({ width: 3, height: 2, data: new Uint8Array(24) })
    const canvas = body.querySelector('canvas')!
    expect([canvas.width, canvas.height]).toEqual([3, 2])
    body.remove()
  })
})
