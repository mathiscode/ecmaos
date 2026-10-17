import type { HostDisplay, ToDisplay, ToKernel, WindowContent, WindowId, WindowInfo, WindowKind, WindowOptions, WindowRenderer, WindowReports } from '@ecmaos/types'

import { browserLauncher } from './launch.ts'
import type { HostWindow, Launcher } from './launch.ts'
import { DisplayServer } from './server.ts'
import type { DisplaySession } from './server.ts'

export { browserLauncher, findBrowser } from './launch.ts'
export type { HostWindow, Launcher } from './launch.ts'
export { DisplayServer } from './server.ts'

export interface NodeDisplayOptions {
  /** Opens host windows; the system browser in app mode when omitted */
  launcher?: Launcher
  env?: NodeJS.ProcessEnv
  log?: (text: string) => void
}

/** `Errno.ENODEV`; the kernel reads it from `errno` to answer a syscall */
const ENODEV = 19

/** How long a server with no windows is kept, in case another opens right away */
const IdleAfter = 500

/** How long a closing host window gets to go away by itself before its process is killed */
const KillAfter = 1500

interface Slot {
  info: WindowInfo
  content?: WindowContent
  session?: DisplaySession
  host?: HostWindow
  closing: boolean
}

/**
 * Host windows for a Node process. Nothing starts until a program asks for a window: the first one starts a loopback
 * display server and opens a host window loading the display page, and each further ecmaOS window gets a host window of
 * its own. Closing a host window asks the kernel to close the ecmaOS window; if the owner vetoes, the host window opens again.
 */
export class NodeWindowRenderer implements WindowRenderer {
  private _reports?: WindowReports
  private _server?: Promise<DisplayServer>
  private readonly _slots = new Map<WindowId, Slot>()
  private readonly _launcher: Launcher

  constructor(private readonly _options: NodeDisplayOptions = {}) {
    this._launcher = _options.launcher ?? browserLauncher(_options.env)
  }

  get unavailable() { return this._launcher.unavailable }

  supports(kind: WindowKind) { return kind === 'web' }

  attach(reports: WindowReports) { this._reports = reports }

  create(info: WindowInfo, options: WindowOptions) {
    if (this._launcher.unavailable) throw Object.assign(new Error(`Windows are unavailable: ${this._launcher.unavailable}`), { errno: ENODEV })
    const content: WindowContent | undefined = options.html !== undefined ? { html: options.html } : undefined
    const slot: Slot = { info: { ...info }, content, closing: false }
    this._slots.set(info.id, slot)
    void this._open(slot)
  }

  update(info: WindowInfo) {
    const slot = this._slots.get(info.id)
    if (!slot) return
    slot.info = { ...info }
    slot.session?.send({ t: 'update', id: info.id, title: info.title, geometry: info.geometry, state: info.state })
  }

  content(id: WindowId, content: WindowContent) {
    const slot = this._slots.get(id)
    if (!slot) return
    slot.content = content
    slot.session?.send({ t: 'content', id, content })
  }

  close(id: WindowId) {
    const slot = this._slots.get(id)
    if (!slot) return
    this._slots.delete(id)
    slot.closing = true
    slot.session?.send({ t: 'close', id })
    const host = slot.host
    const timer = setTimeout(() => host?.kill(), KillAfter)
    timer.unref()
    void host?.exited.then(() => clearTimeout(timer))
    // the socket is closed by the page after it has handled `close`; end the session once it has had the chance
    setTimeout(() => slot.session?.close(), 100).unref()
  }

  /** Closes every host window and the server */
  async dispose() {
    for (const id of [...this._slots.keys()]) this.close(id)
    const server = await this._server?.catch(() => undefined)
    this._server = undefined
    await server?.close()
  }

  private async _open(slot: Slot) {
    const id = slot.info.id
    try {
      const server = await this._serve()
      if (slot.closing) return
      const session = server.open(id, {
        message: message => this._fromDisplay(id, message),
        disconnect: () => this._hostGone(slot)
      })
      slot.session = session
      session.send({ t: 'open', id, title: slot.info.title, geometry: slot.info.geometry, state: slot.info.state, frameless: slot.info.frameless, modal: slot.info.modal, content: slot.content } satisfies ToDisplay)
      slot.host = this._launcher.launch(session.url, slot.info.geometry, slot.info.title)
    } catch (error) {
      this._options.log?.(`could not open a host window: ${error instanceof Error ? error.message : String(error)}`)
      this._slots.delete(id)
      this._reports?.closeRequested(id, true)
    }
  }

  private _serve(): Promise<DisplayServer> {
    if (this._server) return this._server
    const starting: Promise<DisplayServer> = DisplayServer.start(() => {
      // the last window closed: stop the server unless another window is about to open
      setTimeout(() => {
        void starting.then(server => {
          if (server.sessions > 0 || this._server !== starting) return
          this._server = undefined
          return server.close()
        })
      }, IdleAfter).unref()
    })
    this._server = starting
    return starting
  }

  private _fromDisplay(id: WindowId, message: ToKernel) {
    if (message.t === 'focused') this._reports?.focused(id)
    else if (message.t === 'changed') this._reports?.changed(id, { state: message.state, geometry: message.geometry, title: message.title })
    else if (message.t === 'close-request') this._reports?.closeRequested(id)
  }

  /** The page's socket closed without the kernel asking: the user closed the host window, or the browser died */
  private _hostGone(slot: Slot) {
    if (slot.closing) return
    slot.session = undefined
    slot.host?.kill()
    slot.host = undefined
    const closed = this._reports?.closeRequested(slot.info.id) ?? true
    if (closed) this._slots.delete(slot.info.id)
    else void this._open(slot)
  }
}

/** The display a Node host offers the kernel: windows open as host windows on demand */
export function nodeDisplay(options: NodeDisplayOptions = {}): HostDisplay & { renderer: NodeWindowRenderer } {
  const renderer = new NodeWindowRenderer(options)
  return {
    renderer,
    get unavailable() { return renderer.unavailable },
    close: () => renderer.dispose()
  }
}
