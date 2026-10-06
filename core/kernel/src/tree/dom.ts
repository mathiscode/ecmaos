import type { Notyf } from 'notyf'
import type { DomOptions } from '@ecmaos/types'
import type topbarModule from 'topbar'
import type { TopbarConfigOptions } from 'topbar'

export const DefaultDomOptions: DomOptions = { topbar: true }

/** Answers every Notyf call (`success`, `error`, `open`, ...) with nothing. */
const NullToast = new Proxy({}, { get: () => () => undefined }) as unknown as Notyf

export class Dom {
  private _document: Document = globalThis.document
  private _navigator: Navigator = globalThis.navigator
  private _window: Window = globalThis.window
  private _topbarEnabled: boolean = false
  private _topbarShow: boolean = false
  private _toast?: Notyf
  private _topbar?: typeof topbarModule
  private _options: DomOptions

  get document() { return this._document }
  get navigator() { return this._navigator }
  get window() { return this._window }
  /** Toast notifications; a silent stand-in when there is no DOM (or before `init`). */
  get toast(): Notyf { return this._toast ?? NullToast }

  constructor(_options: DomOptions = DefaultDomOptions) {
    const options = { ...DefaultDomOptions, ..._options }
    this._options = options
    this._topbarEnabled = options.topbar ?? true
  }

  /** topbar, notyf and the notyf stylesheet touch `window`/`document` at import or construction, so they load here, in a browser only. */
  async init() {
    if (!globalThis.document || this._toast) return
    const [{ default: topbar }, { Notyf }] = await Promise.all([
      import('topbar'),
      import('notyf'),
      import('notyf/notyf.min.css')
    ])
    this._topbar = topbar
    this._toast = new Notyf(this._options.toast)
  }

  async topbar(show?: boolean) {
    if (!this._topbarEnabled) return
    this._topbarShow = show ?? !this._topbarShow
    if (this._topbarShow) this._topbar?.show()
    else this._topbar?.hide()
  }

  async topbarConfig(options: TopbarConfigOptions) {
    if (!this._topbarEnabled) return
    this._topbar?.config(options)
  }

  async topbarProgress(value: number) {
    if (!this._topbarEnabled) return
    this._topbar?.progress(value)
  }

  /**
   * Shows a quick flash indicator for the TTY number in the top-right corner
   * @param ttyNumber - TTY number to display
   */
  showTtyIndicator(ttyNumber: number): void {
    if (!this._document) return
    const existingIndicator = this._document.getElementById('tty-indicator')
    if (existingIndicator) existingIndicator.remove()

    const indicator = this._document.createElement('div')
    indicator.id = 'tty-indicator'
    indicator.className = 'tty-indicator'
    indicator.textContent = `TTY ${ttyNumber}`
    this._document.body.appendChild(indicator)

    requestAnimationFrame(() => indicator.classList.add('show'))

    setTimeout(() => {
      indicator.classList.remove('show')
      setTimeout(() => {
        if (indicator.parentNode) indicator.remove()
      }, 300)
    }, 1500)
  }

  private _mobileControls: MobileControls | null = null

  enableMobileControls(onKey: (key: string, code: string) => void) {
    if (this._mobileControls) return
    this._mobileControls = new MobileControls(onKey)
    this._mobileControls.mount()
  }

  disableMobileControls() {
    if (this._mobileControls) {
      this._mobileControls.unmount()
      this._mobileControls = null
    }
  }
}

class MobileControls {
  private _container: HTMLElement | null = null
  private _onKey: (key: string, code: string) => void

  constructor(onKey: (key: string, code: string) => void) {
    this._onKey = onKey
  }

  mount() {
    if (this._container) return

    this._container = document.createElement('div')
    this._container.className = 'mobile-controls-container'

    const dPad = document.createElement('div')
    dPad.className = 'd-pad'

    dPad.appendChild(this._createButton('▲', 'ArrowUp', 'ArrowUp', 'btn-up'))
    dPad.appendChild(this._createButton('◀', 'ArrowLeft', 'ArrowLeft', 'btn-left'))
    dPad.appendChild(this._createButton('▼', 'ArrowDown', 'ArrowDown', 'btn-down'))
    dPad.appendChild(this._createButton('▶', 'ArrowRight', 'ArrowRight', 'btn-right'))

    this._container.appendChild(dPad)
    document.body.appendChild(this._container)
  }

  unmount() {
    if (this._container) {
      this._container.remove()
      this._container = null
    }
  }

  private _createButton(label: string, key: string, code: string, className: string): HTMLElement {
    const btn = document.createElement('div')
    btn.className = `d-pad-btn ${className}`
    btn.textContent = label

    const handleTouch = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      this._onKey(key, code)
    }

    btn.addEventListener('touchstart', handleTouch, { passive: false })
    btn.addEventListener('mousedown', handleTouch) // For testing on desktop

    return btn
  }
}
