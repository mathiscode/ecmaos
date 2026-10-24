import type { MinimizeMode, WindowId, WindowInfo, WindowInsets, WindowKind, WindowOptions, WindowRenderer, WindowReports, WindowState } from '@ecmaos/types'

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
  /** Minimized windows hidden because the minimize mode is `hidden` */
  private _hidden: Set<WindowId> = new Set()
  /** Windows hidden because they are on another workspace */
  private _elsewhere: Set<WindowId> = new Set()
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
      if (state === 'minimized') this._hideIfShellShows(id)
      setTimeout(() => this._updateBodyClass(), 0)
      if (!this._applying) this._reports?.changed(id, { state })
    }

    params.onminimize = () => report('minimized')
    params.onrestore = () => report('normal')
    params.onmaximize = () => report('maximized')
    params.onfullscreen = () => report('fullscreen')
    params.onfocus = () => { if (!this._applying) this._reports?.focused(id) }
    // WinBox moves and resizes a window to minimize or maximize it, before it marks it as such. The report waits for the
    // call to finish, and a window that is then minimized, maximized or fullscreen is not at its own geometry.
    const reportGeometry = () => queueMicrotask(() => {
      const box = this._boxes.get(id)
      if (this._applying || !box || box.min || box.max || box.full) return
      this._reports?.changed(id, { geometry: { x: box.x, y: box.y, width: box.width, height: box.height } })
    })
    params.onmove = () => { if (!this._applying) reportGeometry() }
    params.onresize = () => { if (!this._applying) reportGeometry() }
    // WinBox closes the window itself when this returns false; true keeps it
    params.onclose = () => {
      const closed = this._reports?.closeRequested(id) ?? true
      if (closed) {
        this._boxes.delete(id)
        this._hidden.delete(id)
        this._elsewhere.delete(id)
        setTimeout(() => this._updateBodyClass(), 0)
      }
      return !closed
    }

    const box = new WinBoxCtor(params) as WinBoxState
    this._boxes.set(id, box)
    this._focusInside(box)
    // where WinBox put it: a centred window was recorded at 0, 0
    return { body: box.body as HTMLElement, dom: box.dom as HTMLElement, geometry: { x: box.x, y: box.y, width: box.width, height: box.height } }
  }

  update(info: WindowInfo) {
    const box = this._boxes.get(info.id)
    if (!box) return
    this._applying = true
    try {
      if (box.title !== info.title) box.setTitle(info.title)
      if (info.hidden !== this._elsewhere.has(info.id)) {
        if (info.hidden) { this._elsewhere.add(info.id); box.hide() } else { this._elsewhere.delete(info.id); if (!this._hidden.has(info.id)) box.show() }
      }
      if (info.state !== 'minimized') this._unhide(info.id)
      const current: WindowState = box.min ? 'minimized' : box.full ? 'fullscreen' : box.max ? 'maximized' : 'normal'
      if (current !== info.state) {
        if (info.state === 'minimized') { box.minimize(); this._hideIfShellShows(info.id) }
        else if (info.state === 'maximized') box.maximize()
        else if (info.state === 'fullscreen') box.fullscreen()
        else box.restore()
      }

      // A minimized, maximized or fullscreen window is not at its own geometry; it is applied once the window is normal
      if (info.state === 'normal') {
        const { x, y, width, height } = info.geometry
        if (box.x !== x || box.y !== y) box.move(x, y)
        if (box.width !== width || box.height !== height) box.resize(width, height)
      }

      if (info.focused && !info.hidden) { box.focus(); this._focusInside(box) }
    } finally {
      this._applying = false
    }
    this._updateBodyClass()
  }

  /** WinBox raises and styles a focused window but leaves the keyboard where it was; a window that holds nothing focused takes it, so typing goes to the window that just opened */
  private _focusInside(box: WinBoxState) {
    const body = box.body as HTMLElement | undefined
    if (!body || !globalThis.document || body.contains(document.activeElement)) return
    const target = body.querySelector<HTMLElement>('textarea, input, select, [tabindex]:not([tabindex="-1"]), iframe, canvas[tabindex]')
    if (!target) body.tabIndex = -1
    ;(target ?? body).focus({ preventScroll: true })
  }

  /** Windows opened from now on keep to the new work area; open ones are moved back inside it */
  workareaChanged(insets: WindowInsets) {
    for (const box of this._boxes.values()) {
      Object.assign(box, insets)
      // @ts-ignore - re-applies the margins to a maximized window and clamps the others
      box.resize?.(box.width, box.height)
    }
  }

  /** Minimized windows leave the dock for hiding, or come back to it */
  minimizeModeChanged(mode: MinimizeMode) {
    for (const [id, box] of this._boxes) {
      if (!box.min) continue
      if (mode === 'hidden') this._hideIfShellShows(id)
      else this._unhide(id)
    }
    this._updateBodyClass()
  }

  /** In `hidden` mode a minimized window is not drawn; its state stays `minimized` */
  private _hideIfShellShows(id: WindowId) {
    const box = this._boxes.get(id)
    if (!box || this._reports?.minimizeMode() !== 'hidden') return
    this._hidden.add(id)
    box.hide()
  }

  private _unhide(id: WindowId) {
    if (!this._hidden.delete(id)) return
    if (!this._elsewhere.has(id)) this._boxes.get(id)?.show()
  }

  /** Closes the WinBox without asking `onclose` again; the server has already decided */
  close(id: WindowId) {
    const box = this._boxes.get(id)
    if (!box) return
    this._boxes.delete(id)
    this._hidden.delete(id)
    this._elsewhere.delete(id)
    this._applying = true
    try { box.close(true) } finally { this._applying = false }
    this._updateBodyClass()
  }

  private _updateBodyClass() {
    let minimizedCount = 0
    for (const [id, box] of this._boxes) if (box.min && !this._hidden.has(id) && !this._elsewhere.has(id)) minimizedCount++
    document.body.classList.toggle('has-minimized-windows', minimizedCount > 0)
  }
}
