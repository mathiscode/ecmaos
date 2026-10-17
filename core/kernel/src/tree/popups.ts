import type { WindowId, WindowInfo, WindowKind, WindowOptions, WindowRenderer, WindowReports } from '@ecmaos/types'

export interface PopupOptions {
  /** Whether new windows are popups; read at each window, so it can change while the kernel runs */
  enabled: () => boolean
  /** The browser's `window.open`; replaceable for tests */
  open?: (url: string, target: string, features: string) => Window | null
  /** The page whose stylesheets popups copy */
  document?: Document
}

interface Popup {
  window: Window
  /** The element handed to the window's creator */
  body: HTMLElement
  /** Set when the machine closes the popup, so the browser's close event is not reported as the user's */
  closing: boolean
  timer: ReturnType<typeof setInterval>
  geometry: string
  /** The server's latest record and the creation options, for drawing the window elsewhere if the user closes the popup and the machine refuses */
  info: WindowInfo
  options: WindowOptions
}

/**
 * An optional, seamless mode: each window is a separate browser popup, so the operating system's window manager places
 * it, instead of a box drawn inside the page. The popup's content is an element of the page moved into the popup's
 * document, so DOM windows work unchanged. A popup needs a user gesture: when the browser refuses it (or a popup is
 * closed by the user while the machine wants to keep the window) the window is drawn by `fallback` instead, with its
 * content moved there.
 */
export class PopupRenderer implements WindowRenderer {
  private _popups = new Map<WindowId, Popup>()
  private _inFallback = new Set<WindowId>()
  private _reports?: WindowReports

  constructor(private readonly _fallback: WindowRenderer, private readonly _options: PopupOptions) {}

  supports(kind: WindowKind) {
    return kind === 'web' && this._options.enabled() && this._fallback.supports(kind)
  }

  attach(reports: WindowReports) {
    this._reports = reports
  }

  create(info: WindowInfo, options: WindowOptions) {
    const popup = this._open(info, options)
    if (!popup) return this._fallbackCreate(info, options)
    return { body: popup.body, dom: popup.body }
  }

  update(info: WindowInfo) {
    if (this._inFallback.has(info.id)) return this._fallback.update(info)
    const popup = this._popups.get(info.id)
    if (!popup || popup.window.closed) return
    popup.info = info
    popup.window.document.title = info.title
    if (info.state === 'normal') {
      const { x, y, width, height } = info.geometry
      const text = this._geometryOf(popup.window)
      if (text !== `${x},${y},${width},${height}`) {
        popup.geometry = `${x},${y},${width},${height}`
        try { popup.window.resizeTo(width, height); popup.window.moveTo(x, y) } catch { /* the browser refused */ }
      }
    } else if (info.state === 'maximized' || info.state === 'fullscreen') {
      try { popup.window.moveTo(0, 0); popup.window.resizeTo(screen.availWidth, screen.availHeight) } catch { /* refused */ }
    }
    if (info.focused) popup.window.focus()
  }

  close(id: WindowId) {
    if (this._inFallback.delete(id)) return this._fallback.close(id)
    const popup = this._popups.get(id)
    if (!popup) return
    this._popups.delete(id)
    popup.closing = true
    clearInterval(popup.timer)
    try { popup.window.close() } catch { /* already gone */ }
  }

  content(id: WindowId, content: Parameters<NonNullable<WindowRenderer['content']>>[1]) {
    if (this._inFallback.has(id)) this._fallback.content?.(id, content)
  }

  workareaChanged(insets: Parameters<NonNullable<WindowRenderer['workareaChanged']>>[0]) {
    this._fallback.workareaChanged?.(insets)
  }

  minimizeModeChanged(mode: Parameters<NonNullable<WindowRenderer['minimizeModeChanged']>>[0]) {
    this._fallback.minimizeModeChanged?.(mode)
  }

  private _geometryOf(window: Window) {
    return `${window.screenX},${window.screenY},${window.outerWidth},${window.outerHeight}`
  }

  private _fallbackCreate(info: WindowInfo, options: WindowOptions) {
    this._inFallback.add(info.id)
    return this._fallback.create(info, options)
  }

  private _open(info: WindowInfo, options: WindowOptions): Popup | undefined {
    const { x, y, width, height } = info.geometry
    const open = this._options.open ?? ((url, target, features) => window.open(url, target, features))
    let popupWindow: Window | null = null
    try {
      popupWindow = open('', `ecmaos-${String(info.id)}`, `popup=yes,left=${Math.round(x)},top=${Math.round(y)},width=${Math.round(width)},height=${Math.round(height)}`)
    } catch { /* treated as refused */ }
    if (!popupWindow) return undefined

    const doc = popupWindow.document
    doc.title = info.title
    doc.body.style.cssText = 'margin:0;height:100vh;overflow:hidden;background:#000;color:#fff'
    for (const sheet of (this._options.document ?? document).querySelectorAll('link[rel="stylesheet"], style')) doc.head.append(doc.importNode(sheet, true))
    const body = doc.createElement('div')
    body.className = options.class ?? ''
    body.style.cssText = 'width:100%;height:100%;overflow:auto'
    if (options.html !== undefined) body.innerHTML = options.html
    doc.body.append(body)

    const popup: Popup = { window: popupWindow, body, closing: false, geometry: '', timer: undefined as never, info, options }
    const id = info.id
    // the user moves or resizes it: the browser has no event for a move, so the position is looked at now and then
    popup.timer = setInterval(() => {
      if (popup.window.closed) return this._gone(id, popup)
      const text = this._geometryOf(popup.window)
      if (text === popup.geometry) return
      popup.geometry = text
      this._reports?.changed(id, { geometry: { x: popup.window.screenX, y: popup.window.screenY, width: popup.window.outerWidth, height: popup.window.outerHeight } })
    }, 400)
    popupWindow.addEventListener('focus', () => this._reports?.focused(id))
    popupWindow.addEventListener('pagehide', () => this._gone(id, popup))
    // the page going away takes its popups with it
    window.addEventListener('pagehide', () => { try { popup.window.close() } catch { /* gone */ } })
    this._popups.set(id, popup)
    return popup
  }

  /** The popup closed. If the machine did it, nothing more; if the user did, the window is asked to close, and moves into the page when it refuses */
  private _gone(id: WindowId, popup: Popup) {
    if (popup.closing || this._popups.get(id) !== popup) return
    clearInterval(popup.timer)
    this._popups.delete(id)
    if (this._reports?.closeRequested(id)) return
    // refused: the window lives on in the page
    this._inFallback.add(id)
    const made = this._fallback.create({ ...popup.info, geometry: { ...popup.info.geometry } }, popup.options)
    made?.body?.append(popup.body)
  }
}
