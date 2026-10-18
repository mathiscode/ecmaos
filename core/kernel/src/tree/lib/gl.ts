/**
 * GL devices: `/dev/gl<N>` on major 226, one OpenGL ES context each, drawn by the browser's WebGL2. A program writes a
 * stream of commands (see `gl-commands.ts`), asks for a frame with `GL_SWAP` and reads the pixels back as
 * `xrgb8888`, blue first and the top row first, the way `/dev/fb<N>` takes them; a compositor copies them into the
 * buffer of its window. `/dev/glctl` makes the contexts: `GLCTL_CREATE` answers the number of a new one.
 *
 * A context draws off screen, so it has no window of its own. The driver cannot tell who has a node open, so a
 * context lives until `GL_DESTROY` or until the process that made it ends.
 */

import { Class, Device, char_dev } from '@zenfs/linux'
import type { DeviceFile, FileOperations } from '@zenfs/linux'
import { withErrno } from 'kerium'

import { GlCommandByOp } from './gl-commands.ts'

export const GlMajor = 226
export const GlControlMinor = 128
export const MaxGlContexts = 16
export const GlMaxSize = 4096

/** Private ioctls. The type byte 0x47 is how the `ioctl` syscall knows to hand the answer back (see `evdev.ts`) */
export const GLCTL_CREATE = 0x47c0
export const GL_SWAP = 0x4700
export const GL_RESIZE = 0x4701
export const GL_GETINFO = 0x4702
export const GL_DESTROY = 0x4703
export const GlType = 0x47

/** What a context draws with: the part of `WebGL2RenderingContext` the commands and the readback use */
export interface GlLike {
  readPixels(x: number, y: number, width: number, height: number, format: number, type: number, into: Uint8Array): void
  getError(): number
  readonly RGBA: number
  readonly UNSIGNED_BYTE: number
  readonly NO_ERROR: number
  [method: string]: unknown
}

/** Makes the WebGL2 context for a surface of `width` by `height` pixels, and resizes it */
export interface GlSurface {
  gl: GlLike
  resize(width: number, height: number): void
  destroy(): void
}
export type GlSurfaceFactory = (width: number, height: number) => GlSurface

/** WebGL2 on an off-screen canvas, or on a canvas of the page when there is no `OffscreenCanvas` */
export const webGl2Surface: GlSurfaceFactory = (width, height) => {
  const g = globalThis as unknown as { OffscreenCanvas?: new (w: number, h: number) => HTMLCanvasElement, document?: Document }
  const canvas = g.OffscreenCanvas ? new g.OffscreenCanvas(width, height) : g.document?.createElement('canvas')
  if (!canvas) throw withErrno('ENODEV', 'no WebGL2 here')
  canvas.width = width
  canvas.height = height
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' }) as unknown as GlLike | null
  if (!gl) throw withErrno('ENODEV', 'no WebGL2 here')
  return {
    gl,
    resize(w, h) { canvas.width = w; canvas.height = h },
    destroy() { (gl as unknown as WebGL2RenderingContext).getExtension('WEBGL_lose_context')?.loseContext() }
  }
}

export class GlContext {
  frame: Uint8Array
  /** Where the next `read` on the node starts; a swap puts it back to the top */
  cursor = 0
  frames = 0
  /** The first error a command ended in, until `GL_GETINFO` reports it: a GL error code, or `0x10000` for a bad stream */
  error = 0
  private _pending = new Uint8Array(0)
  private _scratch: Uint8Array
  private _surface: GlSurface

  constructor(readonly index: number, public width: number, public height: number, make: GlSurfaceFactory, readonly owner?: number) {
    this._surface = make(width, height)
    this.frame = new Uint8Array(width * height * 4)
    this._scratch = new Uint8Array(width * height * 4)
  }

  get path() { return `/dev/gl${this.index}` }

  /** Runs the commands in `data`; a record cut off at the end waits for the rest. Returns how many bytes it took */
  write(data: Uint8Array): number {
    let bytes = data
    if (this._pending.length) {
      bytes = new Uint8Array(this._pending.length + data.length)
      bytes.set(this._pending)
      bytes.set(data, this._pending.length)
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let at = 0
    try {
      while (bytes.length - at >= 4) {
        const header = view.getUint32(at, true)
        const words = header & 0xffff
        if (bytes.length - at < 4 + words * 4) break
        this._run(header >>> 16, view, at + 4, words)
        at += 4 + words * 4
      }
    } finally {
      this._pending = bytes.slice(at)
    }
    return data.length
  }

  private _run(op: number, view: DataView, at: number, words: number) {
    const command = GlCommandByOp.get(op)
    if (!command || command.sig.length !== words) { this._pending = new Uint8Array(0); this.error ||= 0x10000; throw withErrno('EINVAL', `bad GL command ${op}`) }
    const args: number[] = []
    for (let i = 0; i < words; i++) {
      const letter = command.sig[i]
      args.push(letter === 'f' ? view.getFloat32(at + i * 4, true) : letter === 'u' ? view.getUint32(at + i * 4, true) : view.getInt32(at + i * 4, true))
    }
    const gl = this._surface.gl
    ;(gl[command.name] as (...a: number[]) => unknown).apply(gl, args)
  }

  /** Finishes the commands so far and keeps the picture as the frame to read; returns the number of frames made */
  swap(): number {
    const gl = this._surface.gl
    const { width, height } = this
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this._scratch)
    // red, green, blue, alpha from the bottom row up -> blue, green, red, unused from the top row down
    const source = new Uint32Array(this._scratch.buffer)
    const target = new Uint32Array(this.frame.buffer)
    for (let y = 0; y < height; y++) {
      const from = (height - 1 - y) * width, to = y * width
      for (let x = 0; x < width; x++) {
        const pixel = source[from + x]!
        target[to + x] = (pixel & 0xff00ff00) | ((pixel & 0xff) << 16) | ((pixel >>> 16) & 0xff)
      }
    }
    this.cursor = 0
    return ++this.frames >>> 0
  }

  /** Copies the frame out from the cursor and moves it on; 0 at the end */
  read(into: Uint8Array): number {
    const count = Math.max(0, Math.min(into.length, this.frame.length - this.cursor))
    into.set(this.frame.subarray(this.cursor, this.cursor + count))
    this.cursor += count
    return count
  }

  resize(width: number, height: number) {
    this.width = width
    this.height = height
    this._surface.resize(width, height)
    this.frame = new Uint8Array(width * height * 4)
    this._scratch = new Uint8Array(width * height * 4)
    this.cursor = 0
  }

  /** Width, height, frames so far and the pending error (cleared by asking) */
  info(): Uint8Array {
    const out = new Uint8Array(16)
    const view = new DataView(out.buffer)
    const glError = this._surface.gl.getError()
    view.setUint32(0, this.width, true)
    view.setUint32(4, this.height, true)
    view.setUint32(8, this.frames >>> 0, true)
    view.setUint32(12, this.error || glError, true)
    this.error = 0
    return out
  }

  destroy() { this._surface.destroy() }
}

// - the nodes ------------------------------------------------------------------------------------------

const gl_class = new Class('graphics')
const slots = new Map<number, { context: GlContext, device: Device }>()
let control: Device | undefined
let majorRegistered = false
let surfaceFactory: GlSurfaceFactory = webGl2Surface

/** Replaces what makes the WebGL2 contexts (a test uses a fake); returns the one that was in place */
export function setGlSurfaceFactory(make: GlSurfaceFactory): GlSurfaceFactory {
  const previous = surfaceFactory
  surfaceFactory = make
  return previous
}

export function glContextAt(index: number): GlContext | undefined {
  return slots.get(index)?.context
}

const contextOf = (file: DeviceFile) => {
  const slot = slots.get(file.devt.minor)
  if (!slot) throw withErrno('ENODEV')
  return slot.context
}

const bytesOf = (value: unknown, need: number): Uint8Array => {
  if (!ArrayBuffer.isView(value) || (value as Uint8Array).byteLength < need) throw withErrno('EINVAL')   // may come from another realm, so not instanceof
  const view = value as Uint8Array
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

const sizeIn = (value: unknown) => {
  const bytes = bytesOf(value, 8)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(0, true), height = view.getUint32(4, true)
  if (width < 1 || height < 1 || width > GlMaxSize || height > GlMaxSize) throw withErrno('EINVAL', `a GL surface is 1 to ${GlMaxSize} pixels each way`)
  return { width, height }
}

const u32 = (value: number) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0, true)
  return out
}

let caller: number | undefined
/** The process whose `ioctl` is being answered, so a context it makes goes with it (set by the `ioctl` syscall in `evdev.ts`) */
export function setGlCaller(pid: number | undefined) { caller = pid }

/** Makes a context in the lowest free number, with its node; `owner` is the process it goes with */
export function createGlContext(width: number, height: number, owner?: number): GlContext {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > GlMaxSize || height > GlMaxSize) throw withErrno('EINVAL', `a GL surface is 1 to ${GlMaxSize} pixels each way`)
  let index = 0
  while (slots.has(index)) index++
  if (index >= MaxGlContexts) throw withErrno('ENOSPC', 'no free GL context')
  ensureMajor()
  const context = new GlContext(index, width, height, surfaceFactory, owner)
  let device: Device
  try {
    device = new Device({ name: `gl${index}`, class: gl_class, dev_t: { major: GlMajor, minor: index } })
    device.register()
  } catch (error) {
    context.destroy()
    throw error
  }
  slots.set(index, { context, device })
  return context
}

export function destroyGlContext(index: number) {
  const slot = slots.get(index)
  if (!slot) return
  slots.delete(index)
  slot.context.destroy()
  try { slot.device.unregister() } catch { /* already gone */ }
}

/** Takes away the contexts a process made */
export function destroyGlContextsOf(owner: number) {
  for (const [index, slot] of [...slots]) if (slot.context.owner === owner) destroyGlContext(index)
}

const operations: FileOperations = {
  read: (file, buffer, start, end) => contextOf(file).read(buffer.subarray(0, end - start)),
  write: (file, buffer, offset) => contextOf(file).write(buffer.slice(offset)),
  poll: () => 1 | 4,
  ioctl: {
    [GLCTL_CREATE]: (_context, file, size?: Uint8Array) => {
      if (file.devt.minor !== GlControlMinor) throw withErrno('ENOTTY')
      const { width, height } = sizeIn(size)
      return u32(createGlContext(width, height, caller).index)
    },
    [GL_SWAP]: (_context, file) => u32(contextOf(file).swap()),
    [GL_RESIZE]: (_context, file, size?: Uint8Array) => {
      const { width, height } = sizeIn(size)
      contextOf(file).resize(width, height)
      return 0
    },
    [GL_GETINFO]: (_context, file) => contextOf(file).info(),
    [GL_DESTROY]: (_context, file) => { contextOf(file); destroyGlContext(file.devt.minor); return 0 }
  }
}

function ensureMajor() {
  if (majorRegistered) return
  majorRegistered = true
  try { char_dev.register(GlMajor, 'gl', operations) } catch { /* a second kernel in this realm; the first one's operations answer */ }
  try {
    control = new Device({ name: 'glctl', class: gl_class, dev_t: { major: GlMajor, minor: GlControlMinor } })
    control.register()
  } catch { control = undefined }
}

/** Makes `/dev/glctl`, so a program can ask for a context before it has one */
export function registerGlControl() {
  ensureMajor()
}
