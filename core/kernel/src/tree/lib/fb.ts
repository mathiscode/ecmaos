/**
 * Linux framebuffer devices: `/dev/fb<N>` on major 29, one per window. A `Framebuffer` owns the pixels (32 bits each, blue
 * first: `xrgb8888`), answers the `FBIO*` ioctls the way `fbdev` does and paints its window when the pixels change. A window
 * that draws with the DOM gets a canvas; a host window or a screen is sent the frame as window content.
 *
 * `@zenfs/linux` hands a device neither the file position nor an `mmap`, so a node keeps one write and read cursor
 * (`lseek` moves it, see `installFbSeek`). Programs that map `/dev/fb0` need the `mmap` spike.
 */

import { Class, Device, char_dev, syscalls } from '@zenfs/linux'
import type { DeviceFile, FileOperations, Process } from '@zenfs/linux'
import { withErrno } from 'kerium'
import type { WindowHandle, WindowInput, WindowOwner, Windows } from '@ecmaos/types'

import { attachCanvasInput } from './canvas-input.ts'
import { inputHub, registerWindowInput } from './evdev.ts'

export const FbMajor = 29
export const MaxFramebuffers = 32
export const BytesPerPixel = 4

export const FBIOGET_VSCREENINFO = 0x4600
export const FBIOPUT_VSCREENINFO = 0x4601
export const FBIOGET_FSCREENINFO = 0x4602
export const FBIOPAN_DISPLAY = 0x4606
export const FBIOBLANK = 0x4611
export const FBIO_WAITFORVSYNC = 0x40044620
/** Private: the cursor the window shows, a CSS cursor name (or `none`) in 64 bytes, NUL-terminated */
export const FBIO_SETCURSOR = 0x46f0
/** Private: the state of the window, as a 32-bit integer: 0 normal, 1 maximized, 2 fullscreen, 3 minimized. `GET` answers it, `SET` asks for it */
export const FBIO_GETWINSTATE = 0x46f1
export const FBIO_SETWINSTATE = 0x46f2
/**
 * Private: text moves between the window's program and the user's clipboard in chunks of 4096 bytes: a 32-bit header
 * (bits 0..15 the byte count, bit 16 first chunk, bit 17 last, bits 20..21 for a drop 1 when the text is a list of URIs)
 * then up to 4092 bytes. `SETCLIPBOARD` sends the program's text out; `GETPASTE` and `GETDROP` take the next chunk of
 * what the user pasted or dropped (an empty first and last chunk when there is none).
 */
export const FBIO_SETCLIPBOARD = 0x46f3
export const FBIO_GETPASTE = 0x46f4
export const FBIO_GETDROP = 0x46f5
export const ClipboardChunk = 4096
export const ClipboardMax = 1 << 20
const WindowStates = ['normal', 'maximized', 'fullscreen', 'minimized'] as const

export const VarScreenInfoSize = 160
/** `struct fb_fix_screeninfo` for a 32-bit program (`unsigned long` is 4 bytes), which is every program here */
export const FixScreenInfoSize = 68

export interface PixelFrame {
  width: number
  height: number
  /** `width * height` pixels, 4 bytes each: blue, green, red, unused */
  data: Uint8Array
}

/** Draws a frame wherever the framebuffer's window is shown; `setCursor` changes the pointer over it */
export type PixelSink = ((frame: PixelFrame) => void) & { setCursor?: (cursor: string) => void, setClipboard?: (text: string) => void }

const PresentDelay = 16

export class Framebuffer {
  stride: number
  pixels: Uint8Array
  /** Where the next `read` or `write` on the node starts, in bytes */
  cursor = 0
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _closed = false
  presents = 0

  constructor(readonly index: number, public width: number, public height: number, private readonly _sink: PixelSink) {
    this.stride = width * BytesPerPixel
    this.pixels = new Uint8Array(this.stride * height)
  }

  get path() { return `/dev/fb${this.index}` }

  /** The pointer over the window: a CSS cursor name such as `pointer` or `text`, or `none` */
  setCursor(cursor: string) { this.pointerCursor = cursor; this._sink.setCursor?.(cursor) }
  pointerCursor = 'default'
  /** Text the user pasted and a drop on the window, waiting for the program to take them (see `FBIO_GETPASTE`) */
  incomingPaste: Uint8Array | undefined
  pasteOffset = 0
  dropOffset = 0
  incomingDrop: { bytes: Uint8Array, uris: boolean } | undefined
  private _outgoing: Uint8Array[] = []
  private _outgoingSize = 0

  /** One chunk of text the program sends to the user's clipboard; the last one completes it */
  takeClipboardChunk(chunk: Uint8Array) {
    if (chunk.length < 4) throw withErrno('EINVAL')
    const header = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(0, true)
    const count = header & 0xffff
    if (count > ClipboardChunk - 4 || chunk.length < 4 + count) throw withErrno('EINVAL')
    if (header & 0x10000) { this._outgoing = []; this._outgoingSize = 0 }
    if (this._outgoingSize + count > ClipboardMax) { this._outgoing = []; this._outgoingSize = 0; throw withErrno('EFBIG') }
    this._outgoing.push(chunk.slice(4, 4 + count))
    this._outgoingSize += count
    if (header & 0x20000) {
      const all = new Uint8Array(this._outgoingSize)
      let at = 0
      for (const part of this._outgoing) { all.set(part, at); at += part.length }
      this._outgoing = []
      this._outgoingSize = 0
      this.copiedText = new TextDecoder().decode(all)
      this._sink.setClipboard?.(this.copiedText)
    }
  }
  /** The text the program last put on the clipboard */
  copiedText: string | undefined
  /** The state of the window the screen is shown in; set by `Framebuffers.create` */
  windowControl: { get(): number, set(state: number): void } | undefined
  get size() { return this.pixels.length }
  get closed() { return this._closed }

  /** Copies `data` in at the cursor (cut short at the end of the screen) and moves the cursor on; returns how much went in */
  write(data: Uint8Array): number {
    if (this._closed) throw withErrno('ENODEV')
    if (this.cursor >= this.size) throw withErrno('ENOSPC')
    const count = Math.min(data.length, this.size - this.cursor)
    this.pixels.set(data.subarray(0, count), this.cursor)
    this.cursor += count
    this.present()
    return count
  }

  /** Copies pixels out from the cursor and moves it on; 0 at the end of the screen */
  read(into: Uint8Array): number {
    if (this._closed) throw withErrno('ENODEV')
    const count = Math.max(0, Math.min(into.length, this.size - this.cursor))
    into.set(this.pixels.subarray(this.cursor, this.cursor + count))
    this.cursor += count
    return count
  }

  /** Moves the cursor as `lseek` would; returns the new position */
  seek(offset: number, whence: number): number {
    const base = whence === 0 ? 0 : whence === 1 ? this.cursor : whence === 2 ? this.size : undefined
    if (base === undefined || base + offset < 0) throw withErrno('EINVAL')
    return this.cursor = base + offset
  }

  /** Shows the pixels as they are now, soon: changes made in quick succession are one frame */
  present() {
    if (this._closed || this._timer) return
    this._timer = setTimeout(() => this.flush(), PresentDelay)
    ;(this._timer as { unref?: () => void }).unref?.()
  }

  /** Shows the pixels now */
  flush() {
    clearTimeout(this._timer)
    this._timer = undefined
    if (this._closed) return
    this.presents++
    this._sink({ width: this.width, height: this.height, data: this.pixels })
  }

  /** Gives the screen another size: the pixels start black and the cursor goes to the top */
  resize(width: number, height: number) {
    this.width = width
    this.height = height
    this.stride = width * BytesPerPixel
    this.pixels = new Uint8Array(this.stride * height)
    this.cursor = 0
    this.flush()
  }

  close() {
    this._closed = true
    clearTimeout(this._timer)
    this._timer = undefined
  }

  /** `struct fb_var_screeninfo`: 32 bits per pixel, blue in the low byte */
  varScreenInfo(): Uint8Array {
    const out = new Uint8Array(VarScreenInfoSize)
    const view = new DataView(out.buffer)
    const unknown = 0xffffffff
    const fields = [
      this.width, this.height, this.width, this.height, 0, 0, 32, 0, // resolution, virtual resolution, offset, bits per pixel, grayscale
      16, 8, 0, 8, 8, 0, 0, 8, 0, 24, 0, 0, // red, green, blue, transparency: offset, length, msb_right
      0, 0, unknown, unknown, 0, // nonstd, activate, height and width in mm, accel_flags
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // pixclock, margins, sync lengths, sync, vmode, rotate, colorspace
      0, 0, 0, 0 // reserved
    ]
    fields.forEach((value, index) => view.setUint32(index * 4, value, true))
    return out
  }

  /** `struct fb_fix_screeninfo` as a 32-bit program lays it out */
  fixScreenInfo(): Uint8Array {
    const out = new Uint8Array(FixScreenInfoSize)
    const view = new DataView(out.buffer)
    out.set(new TextEncoder().encode('ecmaOS fb'), 0)
    view.setUint32(20, this.size, true) // smem_len (smem_start at 16 stays 0: there is no physical address)
    view.setUint32(24, 0, true) // type: FB_TYPE_PACKED_PIXELS
    view.setUint32(32, 2, true) // visual: FB_VISUAL_TRUECOLOR
    view.setUint16(36, 1, true) // xpanstep
    view.setUint16(38, 1, true) // ypanstep
    view.setUint32(44, this.stride, true) // line_length
    return out
  }

  /** Whether `info` (a `fb_var_screeninfo` a program sets) asks for the mode the screen is in */
  accepts(info: Uint8Array): boolean {
    if (info.length < 28) return false
    const view = new DataView(info.buffer, info.byteOffset, info.byteLength)
    return view.getUint32(0, true) === this.width && view.getUint32(4, true) === this.height && view.getUint32(24, true) === 32
  }
}

// - the nodes ------------------------------------------------------------------------------------------

const fb_class = new Class('graphics')
const slots = new Map<number, { framebuffer: Framebuffer, device: Device }>()
let majorRegistered = false

const framebufferOf = (file: DeviceFile) => {
  const slot = slots.get(file.devt.minor)
  if (!slot) throw withErrno('ENODEV')
  return slot.framebuffer
}

/** The next chunk of `bytes` from `offset`, as `GETPASTE` and `GETDROP` answer it */
function chunkOf(bytes: Uint8Array | undefined, offset: number, flags = 0): { chunk: Uint8Array, next: number } {
  const chunk = new Uint8Array(ClipboardChunk)
  const total = bytes?.length ?? 0
  const count = Math.min(ClipboardChunk - 4, total - offset)
  const header = count | (offset === 0 ? 0x10000 : 0) | (offset + count >= total ? 0x20000 : 0) | flags
  new DataView(chunk.buffer).setUint32(0, header >>> 0, true)
  if (bytes && count > 0) chunk.set(bytes.subarray(offset, offset + count), 4)
  return { chunk, next: offset + count }
}

const operations: FileOperations = {
  read: (file, buffer, start, end) => framebufferOf(file).read(buffer.subarray(0, end - start)),
  write: (file, buffer, offset) => framebufferOf(file).write(buffer.slice(offset)),
  poll: () => 1 | 4,
  ioctl: {
    [FBIOGET_VSCREENINFO]: (_context, file) => framebufferOf(file).varScreenInfo(),
    [FBIOGET_FSCREENINFO]: (_context, file) => framebufferOf(file).fixScreenInfo(),
    [FBIOPUT_VSCREENINFO]: (_context, file, info?: Uint8Array) => {
      // the one mode there is can be set again; another one cannot
      if (!(info instanceof Uint8Array) || !framebufferOf(file).accepts(info)) throw withErrno('EINVAL')
      return 0
    },
    [FBIOPAN_DISPLAY]: (_context, file) => { framebufferOf(file).flush(); return 0 },
    [FBIOBLANK]: () => 0,
    [FBIO_SETCURSOR]: (_context, file, name?: Uint8Array) => {
      if (!ArrayBuffer.isView(name)) throw withErrno('EINVAL')   // may come from another realm, so not instanceof
      const bytes = name as Uint8Array
      let end = 0
      while (end < bytes.length && bytes[end] !== 0) end++
      const text = String.fromCharCode(...bytes.subarray(0, end))
      if (!/^[a-z]+(-[a-z]+)?$/.test(text)) throw withErrno('EINVAL')
      framebufferOf(file).setCursor(text)
      return 0
    },
    [FBIO_GETWINSTATE]: (_context, file) => {
      const control = framebufferOf(file).windowControl
      const out = new Uint8Array(4)
      new DataView(out.buffer).setInt32(0, control?.get() ?? 0, true)
      return out
    },
    [FBIO_SETWINSTATE]: (_context, file, value?: Uint8Array) => {
      if (!ArrayBuffer.isView(value) || (value as Uint8Array).length < 4) throw withErrno('EINVAL')
      const bytes = value as Uint8Array
      const state = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true)
      if (state < 0 || state >= WindowStates.length) throw withErrno('EINVAL')
      framebufferOf(file).windowControl?.set(state)
      return 0
    },
    [FBIO_SETCLIPBOARD]: (_context, file, chunk?: Uint8Array) => {
      if (!ArrayBuffer.isView(chunk)) throw withErrno('EINVAL')
      const bytes = chunk as Uint8Array
      framebufferOf(file).takeClipboardChunk(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      return 0
    },
    [FBIO_GETPASTE]: (_context, file) => {
      const framebuffer = framebufferOf(file)
      const { chunk, next } = chunkOf(framebuffer.incomingPaste, framebuffer.pasteOffset)
      framebuffer.pasteOffset = next
      if (next >= (framebuffer.incomingPaste?.length ?? 0)) { framebuffer.incomingPaste = undefined; framebuffer.pasteOffset = 0 }
      return chunk
    },
    [FBIO_GETDROP]: (_context, file) => {
      const framebuffer = framebufferOf(file)
      const drop = framebuffer.incomingDrop
      const { chunk, next } = chunkOf(drop?.bytes, framebuffer.dropOffset, drop?.uris ? 0x100000 : 0)
      framebuffer.dropOffset = next
      if (next >= (drop?.bytes.length ?? 0)) { framebuffer.incomingDrop = undefined; framebuffer.dropOffset = 0 }
      return chunk
    },
    [FBIO_WAITFORVSYNC]: () => 0
  }
}

function ensureMajor() {
  if (majorRegistered) return
  majorRegistered = true
  try { char_dev.register(FbMajor, 'fb', operations) } catch { /* a second kernel in this realm; the first one's operations answer */ }
}

/** The framebuffer behind `/dev/fb<index>`, if there is one */
export function framebufferAt(index: number): Framebuffer | undefined {
  return slots.get(index)?.framebuffer
}

/**
 * A device is not told the file position, so the calls that carry one are answered here for framebuffer nodes: `lseek` moves
 * the node's cursor, and a `read` or `write` with a position (`pread`, `pwrite`, what `dd` does for `seek=`) uses that
 * position and leaves the cursor where it was. Idempotent.
 * @param descriptor finds the framebuffer a descriptor of `proc` is open on, or `undefined` for anything else
 */
let seekWrapped = false
export function installFbSeek(descriptor: (proc: Process, fd: number) => Framebuffer | undefined) {
  if (seekWrapped) return
  seekWrapped = true
  type Handler = (proc: Process, ...args: unknown[]) => unknown
  const seek = syscalls.get('lseek' as never) as Handler | undefined
  if (seek) {
    syscalls.set('lseek' as never, ((proc: Process, fd: number, offset: number, whence: number) => {
      const framebuffer = descriptor(proc, fd)
      return framebuffer ? framebuffer.seek(offset, whence) : seek(proc, fd, offset, whence)
    }) as never)
  }
  // `write` is (fd, data, position) and `read` is (fd, count, position); a position below 0 means the current one
  for (const [name, at] of [['write', 2], ['read', 2]] as const) {
    const original = syscalls.get(name as never) as Handler | undefined
    if (!original) continue
    syscalls.set(name as never, (async (proc: Process, ...args: unknown[]) => {
      const framebuffer = descriptor(proc, args[0] as number)
      const position = args[at] as number | undefined
      if (!framebuffer || position === undefined || position < 0) return await original(proc, ...args)
      const saved = framebuffer.cursor
      framebuffer.cursor = position
      try { return await original(proc, ...args) } finally { framebuffer.cursor = saved }
    }) as never)
  }
}

// - windows --------------------------------------------------------------------------------------------

const encodeBase64 = (bytes: Uint8Array) => {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

/** Paints frames into `window`: a canvas when it draws with the DOM, otherwise the frame is its content */
export function windowSink(window: WindowHandle, onInput?: (input: WindowInput) => void): PixelSink {
  let canvas: HTMLCanvasElement | undefined
  let image: ImageData | undefined
  let cursor = 'default'
  const sink: PixelSink = frame => {
    let body: HTMLElement | undefined
    try { body = window.body } catch { /* a window drawn without the DOM */ }
    if (!body) return window.setContent({ pixels: { width: frame.width, height: frame.height, data: encodeBase64(frame.data) } })
    if (canvas && (canvas.width !== frame.width || canvas.height !== frame.height)) { canvas.width = frame.width; canvas.height = frame.height; image = undefined }
    if (!canvas || canvas.ownerDocument !== body.ownerDocument || !body.contains(canvas)) {
      canvas = body.ownerDocument.createElement('canvas')
      canvas.width = frame.width
      canvas.height = frame.height
      canvas.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;background:#000'
      canvas.style.cursor = cursor
      body.replaceChildren(canvas)
      if (onInput) attachCanvasInput(canvas, onInput)
      image = undefined
    }
    const context = canvas.getContext('2d')
    if (!context) return
    image ??= context.createImageData(frame.width, frame.height)
    // blue, green, red, unused -> red, green, blue, opaque
    const source = new Uint32Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength >> 2)
    const target = new Uint32Array(image.data.buffer)
    for (let i = 0; i < source.length; i++) {
      const pixel = source[i]!
      target[i] = 0xff000000 | ((pixel & 0xff) << 16) | (pixel & 0xff00) | ((pixel >>> 16) & 0xff)
    }
    context.putImageData(image, 0, 0)
  }
  sink.setClipboard = text => {
    try { void (globalThis as { navigator?: Navigator }).navigator?.clipboard?.writeText(text).catch(() => {}) } catch { /* no clipboard here */ }
  }
  sink.setCursor = next => {
    cursor = next
    if (canvas) canvas.style.cursor = next
  }
  return sink
}

export interface FramebufferOptions {
  width: number
  height: number
  title?: string
  owner?: WindowOwner
  /** The screen takes the size its window shows it at (after the first report, which is the size it starts with) */
  resizable?: boolean
}

/** The framebuffers of a machine; each has a window and a node */
export class Framebuffers {
  constructor(private readonly _windows: Windows) {}

  list(): Framebuffer[] {
    return [...slots.values()].map(slot => slot.framebuffer)
  }

  get(index: number): Framebuffer | undefined {
    return framebufferAt(index)
  }

  /** Opens a window of `width` by `height` pixels and the node that draws in it; closing the window removes the node */
  create(options: FramebufferOptions): Framebuffer {
    const { width, height } = options
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) throw withErrno('EINVAL', 'a framebuffer is 1 to 4096 pixels each way')
    let index = 0
    while (slots.has(index)) index++
    if (index >= MaxFramebuffers) throw withErrno('ENOSPC', 'no free framebuffer')
    ensureMajor()

    const window = this._windows.create({ title: options.title || `Framebuffer ${index}`, width, height, owner: options.owner })
    const framebuffer = new Framebuffer(index, width, height, windowSink(window, input => this._windows.reportInput(window.id, input)))
    framebuffer.windowControl = {
      get: () => Math.max(0, WindowStates.indexOf(window.info.state as typeof WindowStates[number])),
      set: state => window.setState(WindowStates[state]!)
    }
    const inputNode = registerWindowInput(index, width, height)
    let baseline = false
    const stopInput = this._windows.onInput(window.id, input => {
      if (input.k === 'paste') framebuffer.incomingPaste = new TextEncoder().encode(input.text).subarray(0, ClipboardMax)
      if (input.k === 'drop') framebuffer.incomingDrop = { bytes: new TextEncoder().encode(input.text).subarray(0, ClipboardMax), uris: input.uris === true }
      inputHub.window(inputNode.minor, input)
      if (input.k !== 'size' || !options.resizable) return
      // the first size is how the window starts out; only later ones are the user's
      if (!baseline) { baseline = true; return }
      const next = { width: Math.min(Math.max(input.width, 1), 4096), height: Math.min(Math.max(input.height, 1), 4096) }
      if (next.width === framebuffer.width && next.height === framebuffer.height) return
      framebuffer.resize(next.width, next.height)
      inputNode.resize(next.width, next.height)
    })
    let device: Device
    try {
      device = new Device({ name: `fb${index}`, class: fb_class, dev_t: { major: FbMajor, minor: index } })
      device.register()
    } catch (error) {
      window.close(true)
      throw error
    }
    slots.set(index, { framebuffer, device })
    const stop = this._windows.on('close', info => {
      if (info.id !== window.id) return
      stop()
      stopInput()
      inputNode.remove()
      framebuffer.close()
      slots.delete(index)
      try { device.unregister() } catch { /* already gone */ }
    })
    framebuffer.flush()
    return framebuffer
  }
}
