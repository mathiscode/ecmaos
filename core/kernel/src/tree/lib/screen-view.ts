/**
 * A screen's view of another machine's windows: the windows the machine sends over the display protocol are drawn here as
 * WinBox windows of a window server of the screen's own, and what the user does to them (move, resize, minimize, focus,
 * close) is sent back. The machine stays the authority: closing a window here only asks the machine to close it.
 */

import type { AppLaunch, ToDisplay, ToKernel, WindowContent, WindowHandle, WindowId, Windows } from '@ecmaos/types'

import { frameDocument } from './display-sandbox.ts'
import './display-sandbox/relay.js'

interface AppMount {
  result(call: number, result: unknown, error?: string): void
  dispose(): void
}

declare global {
  // set by `display-sandbox/relay.js`
  var ecmaosMountApp: ((parent: HTMLElement, launch: AppLaunch, frameDocument: string, send: (call: number, op: string, args: unknown[]) => void, onDirty?: (dirty: boolean) => void) => AppMount) | undefined
}

interface Shown {
  handle: WindowHandle
  app?: AppMount
  /** The canvas a framebuffer's frames are drawn in */
  canvas?: HTMLCanvasElement
}

/** Where the first window opens, and how far each next one is moved so they do not all cover each other */
const CascadeStart = 40
const CascadeStep = 32
const CascadeWrap = 10

export class ScreenView {
  private readonly _shown = new Map<WindowId, Shown>()
  private readonly _dirty = new Set<WindowId>()
  private readonly _unsubscribe: Array<() => void> = []
  private _applying = false
  private _opened = 0

  constructor(private readonly _send: (message: ToKernel) => void, private readonly _windows: Windows) {
    this._unsubscribe.push(
      _windows.on('update', info => {
        if (this._applying || !this._shown.has(info.id)) return
        this._send({ t: 'changed', id: info.id, state: info.state, geometry: info.geometry, title: info.title })
      }),
      _windows.on('focus', info => {
        if (this._applying || !this._shown.has(info.id) || !info.focused) return
        this._send({ t: 'focused', id: info.id })
      })
    )
  }

  /** How many windows are shown */
  get count() { return this._shown.size }

  /** Handles one message from the machine */
  handle(message: ToDisplay) {
    switch (message.t) {
      case 'open': return this._open(message)
      case 'update': return this._update(message)
      case 'content': { const shown = this._shown.get(message.id); if (shown) this._content(message.id, shown, message.content); return }
      case 'close': return this._close(message.id)
      case 'result': return this._shown.get(message.id)?.app?.result(message.call, message.result, message.error)
      case 'ready': return
    }
  }

  /** Closes every window, as the machine going away does */
  dispose() {
    for (const stop of this._unsubscribe.splice(0)) stop()
    for (const id of [...this._shown.keys()]) this._close(id)
  }

  /** Whether any window has unsaved changes */
  get dirty() { return this._dirty.size > 0 }

  private _open(message: Extract<ToDisplay, { t: 'open' }>) {
    if (this._shown.has(message.id)) return
    const { geometry } = message
    // the machine's own default position is the corner; a position it did not choose is cascaded
    const cascade = geometry.x === 0 && geometry.y === 0
    const offset = CascadeStart + (this._opened++ % CascadeWrap) * CascadeStep
    this._applying = true
    try {
      const handle = this._windows.create({
        id: message.id,
        title: message.title,
        x: cascade ? offset : geometry.x,
        y: cascade ? offset : geometry.y,
        width: geometry.width,
        height: geometry.height,
        max: message.state === 'maximized',
        modal: message.modal,
        frameless: message.frameless,
        // the machine decides: closing here asks it to, and the window goes when it says so
        onclose: force => {
          if (force) return false
          this._send({ t: 'close-request', id: message.id })
          return true
        }
      })
      const shown: Shown = { handle }
      this._shown.set(message.id, shown)
      if (message.state === 'minimized' || message.state === 'fullscreen') handle.setState(message.state)
      if (message.content) this._content(message.id, shown, message.content)
    } finally {
      this._applying = false
    }
  }

  private _update(message: Extract<ToDisplay, { t: 'update' }>) {
    const shown = this._shown.get(message.id)
    if (!shown) return
    this._applying = true
    try {
      this._windows.update(message.id, { title: message.title, state: message.state, ...message.geometry })
    } finally {
      this._applying = false
    }
  }

  private _close(id: WindowId) {
    const shown = this._shown.get(id)
    if (!shown) return
    this._shown.delete(id)
    this._setDirty(id, false)
    shown.app?.dispose()
    this._applying = true
    try { shown.handle.close(true) } finally { this._applying = false }
  }

  private _setDirty(id: WindowId, dirty: boolean) {
    if (dirty) this._dirty.add(id)
    else this._dirty.delete(id)
    // the browser asks before the page is left while an app has unsaved changes
    window.onbeforeunload = this._dirty.size ? (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' } : null
  }

  private _content(id: WindowId, shown: Shown, content: WindowContent) {
    if ('pixels' in content) return this._pixels(shown, content.pixels)
    shown.canvas = undefined
    shown.app?.dispose()
    shown.app = undefined
    this._setDirty(id, false)
    const container = document.createElement('div')
    container.style.cssText = 'width:100%;height:100%;overflow:auto;background:#101010;color:#e8e8e8'
    if ('text' in content) {
      const pre = document.createElement('pre')
      pre.style.cssText = 'margin:0;padding:8px;white-space:pre-wrap;word-break:break-word;font:14px monospace'
      pre.textContent = content.text
      container.append(pre)
    } else if ('app' in content) {
      const mount = globalThis.ecmaosMountApp
      if (!mount) throw new Error('the app sandbox is not loaded')
      shown.app = mount(container, content.app, frameDocument, (call, op, args) => this._send({ t: 'call', id, call, op, args }), dirty => this._setDirty(id, dirty))
    } else {
      const frame = document.createElement('iframe')
      frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#fff'
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
      if ('html' in content) frame.srcdoc = content.html
      else frame.src = content.url
      container.append(frame)
    }
    shown.handle.mount(container)
  }

  /** A frame replaces what the canvas shows; the canvas is made once, so frames do not rebuild the window */
  private _pixels(shown: Shown, pixels: { width: number, height: number, data: string }) {
    shown.app?.dispose()
    shown.app = undefined
    if (!shown.canvas?.isConnected) {
      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;background:#000'
      shown.handle.mount(canvas)
      shown.canvas = canvas
    }
    const canvas = shown.canvas
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) { canvas.width = pixels.width; canvas.height = pixels.height }
    const context = canvas.getContext('2d')
    if (!context) return
    const text = atob(pixels.data)
    const image = context.createImageData(pixels.width, pixels.height)
    const target = new Uint32Array(image.data.buffer)
    // blue, green, red, unused -> red, green, blue, opaque
    for (let i = 0; i < target.length; i++) {
      const o = i * 4
      target[i] = 0xff000000 | (text.charCodeAt(o) << 16) | (text.charCodeAt(o + 1) << 8) | text.charCodeAt(o + 2)
    }
    context.putImageData(image, 0, 0)
  }
}
