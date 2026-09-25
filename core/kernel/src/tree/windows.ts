import 'winbox'
import 'winbox/dist/css/winbox.min.css'
// @ts-ignore -- the ESM source ships no types; @types/winbox describes it as WinBox.WinBoxConstructor
import WinBoxModule from 'winbox/src/js/winbox.js'

import type { WindowId, Windows as IWindows } from '@ecmaos/types'

// Bound under its own name: a `declare const WinBox` alongside a same-named import lets the
// transform treat the import as type-only and drop it, leaving `new WinBox()` unbound at runtime.
const WinBoxCtor = WinBoxModule as WinBox.WinBoxConstructor

declare module 'winbox' {
  interface WinBoxConstructor {
    stack(): WinBox[];
  }
}

/** `@types/winbox` omits the minimize/restore/maximize hooks the real WinBox calls. */
type WindowParams = WinBox.Params & {
  onminimize?: (this: WinBox, force?: boolean) => void
  onrestore?: (this: WinBox) => void
  onmaximize?: (this: WinBox) => void
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

const DefaultDialogOptions: WindowParams = {
  ...DefaultWindowOptions,
  modal: true,
  width: 320,
  height: 200,
}

export class Windows implements IWindows {
  private _manager: Map<WindowId, WinBox> = new Map()

  get stack() { return WinBoxCtor.stack() }

  all() {
    return this._manager.entries()
  }

  close(id: WindowId) {
    this._manager.get(id)?.close()
  }
  
  create(_options: WindowParams = DefaultWindowOptions): WinBox {
    const options: WindowParams = { ...DefaultWindowOptions, ..._options }
    const id = options.id || Math.random().toString(36).substring(2, 8)
    options.id = id

    const self = this
    
    const originalOnMinimize = options.onminimize
    options.onminimize = function(this: WinBox, force?: boolean) {
      setTimeout(() => self._updateBodyClass(), 0)
      originalOnMinimize?.call(this, force)
    }

    const originalOnRestore = options.onrestore
    options.onrestore = function(this: WinBox) {
      setTimeout(() => self._updateBodyClass(), 0)
      originalOnRestore?.call(this)
    }

    const originalOnMaximize = options.onmaximize
    options.onmaximize = function(this: WinBox) {
      setTimeout(() => self._updateBodyClass(), 0)
      originalOnMaximize?.call(this)
    }

    const originalOnClose = options.onclose
    options.onclose = function(this: WinBox, force?: boolean) {
      setTimeout(() => self._updateBodyClass(), 0)
      self.remove(id)
      return originalOnClose?.call(this, force) ?? false
    }

    const win = new WinBoxCtor(options)
    this._manager.set(id, win)
    return win
  }

  private _updateBodyClass() {
    let minimizedCount = 0
    for (const win of this._manager.values()) {
      // @ts-ignore
      if (win.min) minimizedCount++
    }

    if (minimizedCount > 0) {
      document.body.classList.add('has-minimized-windows')
    } else {
      document.body.classList.remove('has-minimized-windows')
    }
  }

  dialog(options: WinBox.Params = DefaultDialogOptions) {
    return this.create({ ...DefaultDialogOptions, ...options })
  }

  get(id: WindowId) {
    return this._manager.get(id)
  }

  remove(id: WindowId) {
    this._manager.delete(id)
  }
}
