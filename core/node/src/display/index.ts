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

/** A display somewhere else (a browser logged in over the peer link) that shows the windows of one user */
export interface RemoteDisplay {
  /** Whose windows it shows; root's shows all of them */
  readonly uid: number
  send(message: ToDisplay): void
}

interface RemoteEntry {
  display: RemoteDisplay
  /** The windows it has been told about: it may speak for no others */
  known: Set<WindowId>
}

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
  private readonly _remotes = new Set<RemoteEntry>()
  private readonly _launcher: Launcher

  constructor(private readonly _options: NodeDisplayOptions = {}) {
    this._launcher = _options.launcher ?? browserLauncher(_options.env)
  }

  get unavailable() { return this._launcher.unavailable }

  supports(kind: WindowKind) { return kind === 'web' }

  attach(reports: WindowReports) { this._reports = reports }

  create(info: WindowInfo, options: WindowOptions) {
    const shown = this._showing(info)
    if (!shown.length && this._launcher.unavailable) throw Object.assign(new Error(`Windows are unavailable: ${this._launcher.unavailable}`), { errno: ENODEV })
    const content: WindowContent | undefined = options.html !== undefined ? { html: options.html } : undefined
    const slot: Slot = { info: { ...info }, content, closing: false }
    this._slots.set(info.id, slot)
    // A window opens on the displays attached for its user, or else as a host window of this machine
    if (shown.length) this._announce(slot, shown)
    else void this._open(slot)
  }

  update(info: WindowInfo) {
    const slot = this._slots.get(info.id)
    if (!slot) return
    slot.info = { ...info }
    const message = { t: 'update', id: info.id, title: info.title, geometry: info.geometry, state: info.state } satisfies ToDisplay
    slot.session?.send(message)
    this._toRemotes(info.id, message)
  }

  content(id: WindowId, content: WindowContent) {
    const slot = this._slots.get(id)
    if (!slot) return
    slot.content = content
    slot.session?.send({ t: 'content', id, content })
    this._toRemotes(id, { t: 'content', id, content })
  }

  close(id: WindowId) {
    const slot = this._slots.get(id)
    if (!slot) return
    this._slots.delete(id)
    slot.closing = true
    slot.session?.send({ t: 'close', id })
    this._toRemotes(id, { t: 'close', id })
    for (const remote of this._remotes) remote.known.delete(id)
    const host = slot.host
    const timer = setTimeout(() => host?.kill(), KillAfter)
    timer.unref()
    void host?.exited.then(() => clearTimeout(timer))
    // the socket is closed by the page after it has handled `close`; end the session once it has had the chance
    setTimeout(() => slot.session?.close(), 100).unref()
  }

  /**
   * Attaches a display somewhere else. It is told about the windows its user can see now (all of them for root) and about
   * each one opened later, and while it is attached such a window opens there instead of as a host window of this machine.
   * Returns where to hand what the display sends, and how to detach it; windows left with no display fall back to host windows.
   */
  attachRemote(display: RemoteDisplay): { message(message: ToKernel): void, detach(): void } {
    const entry: RemoteEntry = { display, known: new Set() }
    this._remotes.add(entry)
    for (const slot of this._slots.values()) {
      if (slot.closing || !this._visibleTo(display, slot.info)) continue
      entry.known.add(slot.info.id)
      display.send(this._openMessage(slot))
    }
    return {
      message: message => {
        if (!('id' in message) || !entry.known.has(message.id)) return
        this._fromDisplay(message.id, message, reply => display.send(reply))
      },
      detach: () => {
        if (!this._remotes.delete(entry)) return
        // a window nobody shows any more goes back to this machine, if it can
        for (const id of entry.known) {
          const slot = this._slots.get(id)
          if (!slot || slot.closing || slot.session || this._holders(id).length) continue
          if (this._launcher.unavailable) continue
          void this._open(slot)
        }
      }
    }
  }

  private _visibleTo(display: RemoteDisplay, info: WindowInfo) { return display.uid === 0 || display.uid === info.owner.uid }

  private _showing(info: WindowInfo) { return [...this._remotes].filter(remote => this._visibleTo(remote.display, info)) }

  private _holders(id: WindowId) { return [...this._remotes].filter(remote => remote.known.has(id)) }

  private _toRemotes(id: WindowId, message: ToDisplay) {
    for (const remote of this._holders(id)) remote.display.send(message)
  }

  private _openMessage(slot: Slot): ToDisplay {
    const { info } = slot
    return { t: 'open', id: info.id, title: info.title, geometry: info.geometry, state: info.state, frameless: info.frameless, modal: info.modal, content: slot.content }
  }

  private _announce(slot: Slot, remotes: RemoteEntry[]) {
    for (const remote of remotes) {
      remote.known.add(slot.info.id)
      remote.display.send(this._openMessage(slot))
    }
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
        message: message => this._fromDisplay(id, message, reply => session.send(reply)),
        disconnect: () => this._hostGone(slot)
      })
      slot.session = session
      session.send(this._openMessage(slot))
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

  private _fromDisplay(id: WindowId, message: ToKernel, reply: (message: ToDisplay) => void) {
    if (message.t === 'focused') this._reports?.focused(id)
    else if (message.t === 'changed') this._reports?.changed(id, { state: message.state, geometry: message.geometry, title: message.title })
    else if (message.t === 'call') {
      const { call } = message
      const answer = this._reports?.call(id, message.op, message.args) ?? Promise.reject(new Error('no window server'))
      answer.then(result => reply({ t: 'result', id, call, result: result ?? null }), (error: unknown) => reply({ t: 'result', id, call, error: error instanceof Error ? error.message : String(error) }))
    } else if (message.t === 'close-request') { if (this._reports?.closeRequested(id)) this.close(id) }
  }

  /** The page's socket closed without the kernel asking: the user closed the host window, or the browser died */
  private _hostGone(slot: Slot) {
    if (slot.closing) return
    slot.session = undefined
    slot.host?.kill()
    slot.host = undefined
    const closed = this._reports?.closeRequested(slot.info.id) ?? true
    if (closed) this.close(slot.info.id)
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
