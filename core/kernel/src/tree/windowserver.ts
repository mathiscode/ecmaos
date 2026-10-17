import { Errno } from 'kerium'

import type {
  WindowEvent,
  WindowGeometry,
  WindowHandle,
  WindowId,
  WindowInfo,
  WindowInsets,
  WindowOptions,
  WindowOwner,
  WindowRenderer,
  WindowState,
  WindowReports,
  Windows,
  MinimizeMode
} from '@ecmaos/types'

const KernelOwner: WindowOwner = { pid: 0, uid: 0, gid: 0 }

const DefaultWidth = 300
const DefaultHeight = 300
const DialogWidth = 320
const DialogHeight = 200

interface Entry {
  info: WindowInfo
  options: WindowOptions
  renderer: WindowRenderer
  body?: HTMLElement
  dom?: HTMLElement
  handle: WindowHandle
  /** The state a minimized window had before it was minimized; `focus` returns it to that */
  restoreState?: WindowState
  onCall?: (op: string, args: unknown[]) => Promise<unknown> | unknown
}

const fail = (message: string, errno: Errno) => Object.assign(new Error(message), { errno })

const pixels = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * Window state without any drawing: identity, owner, geometry, state and focus order. A `WindowRenderer` draws the
 * windows; with none that supports a window's kind, `create` fails with ENODEV.
 */
export class WindowServer implements Windows {
  /** Windows one process may have open at once. The kernel (pid 0) is exempt */
  maxPerProcess = 32

  private _workarea: WindowInsets = { top: 0, right: 0, bottom: 0, left: 0 }
  private _minimizeMode: MinimizeMode = 'dock'
  private _workareaListeners: Set<(insets: WindowInsets) => void> = new Set()
  private _renderers: WindowRenderer[] = []
  private _entries: Map<WindowId, Entry> = new Map()
  /** Bottom to top; the last id is focused */
  private _order: WindowId[] = []
  private _listeners: Record<WindowEvent, Set<(info: WindowInfo) => void>> = {
    create: new Set(),
    update: new Set(),
    focus: new Set(),
    close: new Set()
  }

  private readonly _reports: WindowReports = {
    closeRequested: (id, force) => this._closeRequested(id, force),
    changed: (id, patch) => {
      const entry = this._entries.get(id)
      if (!entry) return
      if (patch.title !== undefined) entry.info.title = patch.title
      if (patch.state !== undefined) this._setState(entry, patch.state)
      if (patch.geometry) entry.info.geometry = { ...patch.geometry }
      this._emit('update', entry)
    },
    focused: id => this._raise(id),
    call: async (id, op, args) => {
      const handler = this._entries.get(id)?.onCall
      if (!handler) throw fail(`nothing in window ${id} answers calls`, Errno.ENOSYS)
      return handler(op, args)
    },
    workarea: () => ({ ...this._workarea }),
    minimizeMode: () => this._minimizeMode
  }

  get workarea(): WindowInsets { return { ...this._workarea } }

  setWorkarea(insets: Partial<WindowInsets>) {
    const next = { ...this._workarea, ...insets }
    for (const side of ['top', 'right', 'bottom', 'left'] as const) next[side] = Math.max(0, Math.round(next[side]))
    if (next.top === this._workarea.top && next.right === this._workarea.right && next.bottom === this._workarea.bottom && next.left === this._workarea.left) return
    this._workarea = next
    for (const renderer of this._renderers) renderer.workareaChanged?.({ ...next })
    for (const listener of this._workareaListeners) listener({ ...next })
  }

  get minimizeMode(): MinimizeMode { return this._minimizeMode }

  setMinimizeMode(mode: MinimizeMode) {
    if (mode === this._minimizeMode) return
    this._minimizeMode = mode
    for (const renderer of this._renderers) renderer.minimizeModeChanged?.(mode)
  }

  onWorkarea(listener: (insets: WindowInsets) => void) {
    this._workareaListeners.add(listener)
    return () => { this._workareaListeners.delete(listener) }
  }

  registerRenderer(renderer: WindowRenderer) {
    renderer.attach(this._reports)
    this._renderers.push(renderer)
  }

  create(options: WindowOptions = {}): WindowHandle {
    const kind = options.kind ?? 'web'
    const renderer = this._rendererFor(kind)
    if (!renderer) throw fail(`Windows are unavailable: no window renderer supports '${kind}' windows on this host`, Errno.ENODEV)

    const owner = options.owner ?? KernelOwner
    if (owner.pid !== 0 && this._countOwnedBy(owner.pid) >= this.maxPerProcess) {
      throw fail(`Too many windows open (limit ${this.maxPerProcess})`, Errno.EMFILE)
    }

    const id = options.id ?? this._newId()
    if (this._entries.has(id)) throw fail(`A window with id '${id}' already exists`, Errno.EEXIST)

    const info: WindowInfo = {
      id,
      title: options.title ?? 'Untitled',
      kind,
      owner: { ...owner },
      state: options.max ? 'maximized' : 'normal',
      geometry: {
        x: pixels(options.x, 0),
        y: pixels(options.y, 0),
        width: pixels(options.width, options.modal ? DialogWidth : DefaultWidth),
        height: pixels(options.height, options.modal ? DialogHeight : DefaultHeight)
      },
      focused: false,
      modal: options.modal ?? false,
      frameless: options.frameless ?? false,
      icon: options.icon === undefined ? undefined : String(options.icon),
      created: Date.now()
    }

    const entry: Entry = { info, options: { ...options, id }, renderer, handle: undefined as unknown as WindowHandle }
    entry.handle = this._handleFor(entry)
    const drawn = renderer.create(info, entry.options)
    if (drawn) {
      entry.body = drawn.body
      entry.dom = drawn.dom
    }

    this._entries.set(id, entry)
    this._order.push(id)
    this._emit('create', entry)
    this._raise(id)
    return entry.handle
  }

  dialog(options: WindowOptions = {}): WindowHandle {
    return this.create({ width: DialogWidth, height: DialogHeight, ...options, modal: true })
  }

  get(id: WindowId): WindowHandle | undefined {
    return this._entries.get(id)?.handle
  }

  list(filter: { pid?: number, uid?: number } = {}): WindowInfo[] {
    const infos: WindowInfo[] = []
    for (const id of this._order) {
      const entry = this._entries.get(id)
      if (!entry) continue
      if (filter.pid !== undefined && entry.info.owner.pid !== filter.pid) continue
      if (filter.uid !== undefined && entry.info.owner.uid !== filter.uid) continue
      infos.push(this._snapshot(entry))
    }
    return infos
  }

  focus(id: WindowId) {
    const entry = this._entries.get(id)
    if (!entry) return
    const restored = entry.info.state === 'minimized'
    if (restored) entry.info.state = entry.restoreState ?? 'normal'
    this._raise(id)
    entry.renderer.update(entry.info)
    if (restored) this._emit('update', entry)
  }

  update(id: WindowId, patch: Partial<Pick<WindowInfo, 'state' | 'title'>> & Partial<WindowGeometry>) {
    const entry = this._entries.get(id)
    if (!entry) return
    const { info } = entry
    if (patch.title !== undefined) info.title = patch.title
    if (patch.state !== undefined) this._setState(entry, patch.state)
    if (patch.x !== undefined) info.geometry.x = patch.x
    if (patch.y !== undefined) info.geometry.y = patch.y
    if (patch.width !== undefined) info.geometry.width = patch.width
    if (patch.height !== undefined) info.geometry.height = patch.height
    entry.renderer.update(info)
    this._emit('update', entry)
  }

  close(id: WindowId, force = false): boolean {
    const entry = this._entries.get(id)
    if (!entry) return false
    if (!this._closeRequested(id, force)) return false
    entry.renderer.close(id)
    return true
  }

  closeOwnedBy(pid: number) {
    for (const entry of [...this._entries.values()]) {
      if (entry.info.owner.pid === pid) this.close(entry.info.id, true)
    }
  }

  on(event: WindowEvent, listener: (info: WindowInfo) => void) {
    this._listeners[event].add(listener)
    return () => { this._listeners[event].delete(listener) }
  }

  /** Removes the window if its `onclose` allows. The renderer is told by `close`, or is already closing it */
  private _closeRequested(id: WindowId, force = false): boolean {
    const entry = this._entries.get(id)
    if (!entry) return true
    if (!force && entry.options.onclose?.(force) === true) return false

    this._entries.delete(id)
    this._order = this._order.filter(other => other !== id)
    entry.info.focused = false
    this._emit('close', entry)

    // The window below inherits focus
    const next = this._order[this._order.length - 1]
    if (next !== undefined) this._raise(next)
    return true
  }

  private _setState(entry: Entry, state: WindowState) {
    if (state === 'minimized' && entry.info.state !== 'minimized') entry.restoreState = entry.info.state
    entry.info.state = state
  }

  private _raise(id: WindowId) {
    const entry = this._entries.get(id)
    if (!entry) return
    this._order = this._order.filter(other => other !== id)
    this._order.push(id)
    let changed = false
    for (const other of this._entries.values()) {
      const focused = other.info.id === id
      if (other.info.focused !== focused) { other.info.focused = focused; changed = true }
    }
    if (changed) this._emit('focus', entry)
  }

  private _rendererFor(kind: WindowOptions['kind'] & string) {
    for (let i = this._renderers.length - 1; i >= 0; i--) {
      if (this._renderers[i]!.supports(kind)) return this._renderers[i]
    }
  }

  private _countOwnedBy(pid: number) {
    let count = 0
    for (const entry of this._entries.values()) if (entry.info.owner.pid === pid) count++
    return count
  }

  private _newId() {
    let id: string
    do id = Math.random().toString(36).substring(2, 8)
    while (this._entries.has(id))
    return id
  }

  private _snapshot(entry: Entry): WindowInfo {
    return { ...entry.info, owner: { ...entry.info.owner }, geometry: { ...entry.info.geometry } }
  }

  private _emit(event: WindowEvent, entry: Entry) {
    for (const listener of this._listeners[event]) listener(this._snapshot(entry))
  }

  private _handleFor(entry: Entry): WindowHandle {
    const need = (element: HTMLElement | undefined, what: string) => {
      if (!element) throw fail(`This window has no ${what}: its renderer does not draw with the DOM`, Errno.ENODEV)
      return element
    }
    const id = entry.info.id
    return {
      id,
      get info() { return { ...entry.info, owner: { ...entry.info.owner }, geometry: { ...entry.info.geometry } } },
      get body() { return need(entry.body, 'body') },
      get dom() { return need(entry.dom, 'element') },
      mount: element => need(entry.body, 'body').replaceChildren(element),
      setContent: content => {
        if (!entry.renderer.content) throw fail('This window cannot show content: its renderer draws with the DOM', Errno.ENODEV)
        entry.renderer.content(id, content)
      },
      setTitle: title => this.update(id, { title }),
      move: (x, y) => this.update(id, { x, y }),
      resize: (width, height) => this.update(id, { width, height }),
      setState: state => this.update(id, { state }),
      focus: () => this.focus(id),
      onCall: handler => { entry.onCall = handler },
      close: force => { this.close(id, force) }
    }
  }
}
