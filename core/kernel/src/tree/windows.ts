import type { WindowId, WindowInfo, WindowInsets, WindowKind, WindowOptions, WindowRenderer, WindowReports, WindowState } from '@ecmaos/types'

// WinBox touches `document` at import, so it is loaded by `WinBoxRenderer.init()` in a browser rather than at module load.
// Bound under its own name: a `declare const WinBox` alongside a same-named import lets the
// transform treat the import as type-only and drop it, leaving `new WinBox()` unbound at runtime.
let WinBoxCtor: WinBox.WinBoxConstructor | undefined

declare module 'winbox' {
  interface WinBoxConstructor {
    stack(): WinBox[];
  }
}

/** `@types/winbox` omits the hooks the real WinBox calls for minimize, restore, maximize, focus, move and resize. */
type WindowParams = WinBox.Params & {
  onminimize?: (this: WinBox, force?: boolean) => void
  onrestore?: (this: WinBox) => void
  onmaximize?: (this: WinBox) => void
  onfullscreen?: (this: WinBox) => void
  onfocus?: (this: WinBox) => void
  onmove?: (this: WinBox, x: number, y: number) => void
  onresize?: (this: WinBox, width: number, height: number) => void
}

/** The parts of a WinBox instance that `@types/winbox` leaves out */
type WinBoxState = WinBox & {
  min: boolean
  max: boolean
  full: boolean
  x: number
  y: number
  width: number
  height: number
  restore(): WinBox
  fullscreen(): WinBox
}

const DefaultWindowOptions: WindowParams = {
  background: 'black',
  border: 1,
  class: 'ecmaos-window',
  height: 300,
  title: 'Untitled',
  width: 300,
  x: 'center',
  y: 'center'
}

/**
 * Draws `web` windows with WinBox. The window server owns the state; this renderer loads WinBox when the host has a
 * DOM, opens a WinBox per window, applies the server's changes to it, and reports what the user does to it.
 */
export class WinBoxRenderer implements WindowRenderer {
  private _boxes: Map<WindowId, WinBoxState> = new Map()
  private _reports?: WindowReports
  /** Set while applying the server's change, so the WinBox hooks it triggers are not reported back */
  private _applying = false

  /** Loads WinBox and its stylesheet. A no-op without a DOM; `supports` is then false. */
  async init() {
    if (WinBoxCtor || !globalThis.document) return
    await import('winbox')
    await import('winbox/dist/css/winbox.min.css')
    // @ts-ignore - the ESM source ships no types; @types/winbox describes it as WinBox.WinBoxConstructor
    const module = await import('winbox/src/js/winbox.js')
    WinBoxCtor = module.default as WinBox.WinBoxConstructor
  }

  supports(kind: WindowKind) {
    return kind === 'web' && !!WinBoxCtor
  }

  attach(reports: WindowReports) {
    this._reports = reports
  }

  create(info: WindowInfo, options: WindowOptions) {
    if (!WinBoxCtor) throw new Error('Windows are unavailable: this host has no DOM')
    const id = info.id
    const { x, y, width, height } = options
    const area = this._reports?.workarea()
    const params: WindowParams = {
      ...DefaultWindowOptions,
      ...(area && { top: area.top, right: area.right, bottom: area.bottom, left: area.left }),
      id: String(id),
      title: info.title,
      modal: info.modal,
      max: options.max,
      ...(options.class !== undefined && { class: options.class }),
      ...(options.html !== undefined && { html: options.html }),
      ...(info.icon !== undefined && { icon: info.icon }),
      ...(x !== undefined && { x }),
      ...(y !== undefined && { y }),
      ...(width !== undefined && { width }),
      ...(height !== undefined && { height })
    }

    const report = (state: WindowState) => {
      setTimeout(() => this._updateBodyClass(), 0)
      if (!this._applying) this._reports?.changed(id, { state })
    }

    params.onminimize = () => report('minimized')
    params.onrestore = () => report('normal')
    params.onmaximize = () => report('maximized')
    params.onfullscreen = () => report('fullscreen')
    params.onfocus = () => { if (!this._applying) this._reports?.focused(id) }
    params.onmove = (x, y) => {
      if (this._applying) return
      const box = this._boxes.get(id)
      if (box) this._reports?.changed(id, { geometry: { x, y, width: box.width, height: box.height } })
    }
    params.onresize = (width, height) => {
      if (this._applying) return
      const box = this._boxes.get(id)
      if (box) this._reports?.changed(id, { geometry: { x: box.x, y: box.y, width, height } })
    }
    // WinBox closes the window itself when this returns false; true keeps it
    params.onclose = () => {
      const closed = this._reports?.closeRequested(id) ?? true
      if (closed) {
        this._boxes.delete(id)
        setTimeout(() => this._updateBodyClass(), 0)
      }
      return !closed
    }

    const box = new WinBoxCtor(params) as WinBoxState
    this._boxes.set(id, box)
    return { body: box.body as HTMLElement, dom: box.dom as HTMLElement }
  }

  update(info: WindowInfo) {
    const box = this._boxes.get(info.id)
    if (!box) return
    this._applying = true
    try {
      if (box.title !== info.title) box.setTitle(info.title)
      const { x, y, width, height } = info.geometry
      if (box.x !== x || box.y !== y) box.move(x, y)
      if (box.width !== width || box.height !== height) box.resize(width, height)

      const current: WindowState = box.min ? 'minimized' : box.full ? 'fullscreen' : box.max ? 'maximized' : 'normal'
      if (current !== info.state) {
        if (info.state === 'minimized') box.minimize()
        else if (info.state === 'maximized') box.maximize()
        else if (info.state === 'fullscreen') box.fullscreen()
        else box.restore()
      }

      if (info.focused) box.focus()
    } finally {
      this._applying = false
    }
    this._updateBodyClass()
  }

  /** Windows opened from now on keep to the new work area; open ones are moved back inside it */
  workareaChanged(insets: WindowInsets) {
    for (const box of this._boxes.values()) {
      Object.assign(box, insets)
      // @ts-ignore - re-applies the margins to a maximized window and clamps the others
      box.resize?.(box.width, box.height)
    }
  }

  /** Closes the WinBox without asking `onclose` again; the server has already decided */
  close(id: WindowId) {
    const box = this._boxes.get(id)
    if (!box) return
    this._boxes.delete(id)
    this._applying = true
    try { box.close(true) } finally { this._applying = false }
    this._updateBodyClass()
  }

  private _updateBodyClass() {
    let minimizedCount = 0
    for (const box of this._boxes.values()) if (box.min) minimizedCount++
    document.body.classList.toggle('has-minimized-windows', minimizedCount > 0)
  }
}
