/**
 * Remote displays: a second tab as a terminal of the machine the first tab runs.
 *
 * One tab owns the machine (see `machine-lock.ts`). Another tab does not run a kernel; it shows one of the owner's ttys. The owner
 * mirrors that terminal's output to it, and the display sends back what is typed, which the owner feeds in the way its own keyboard
 * is: login, shells and programs on the tty are the same as at the owner's own screen.
 *
 * Wire: a display announces itself on a discovery channel (`hello`) and the owner answers (`welcome`, with the screen as it is now).
 * The session then runs on a channel named for a random token. Presence is a Web Lock the display holds for as long as it is open, so
 * the owner learns of a closed or crashed display without a heartbeat; the display learns the owner is gone from the machine lock
 * (`keepDisplay`), and attaches again when a machine is back.
 *
 * Some browser calls only work in a page the user is looking at (the clipboard, notifications, speech). A program on a tty with a
 * display attached has them done by that display (`DisplayOwner.present`), not by the owner's tab, which may be in the background.
 *
 * The token travels on the discovery channel, which any same-origin page can read. That is not a boundary worth defending: a
 * same-origin script can read the machine's whole IndexedDB root, `/etc/shadow` included. The origin is the trust boundary.
 */

import { machineLockName } from '#lib/machine-lock.ts'

export const displayChannelName = (store: string) => `ecmaos:display:${store}`
export const displaySessionName = (store: string, token: string) => `ecmaos:display:${store}:${token}`
export const displayLockName = (store: string, token: string) => `ecmaos:display-session:${store}:${token}`

/** What the owner's terminal offers a display */
export interface MirroredTerminal {
  readonly cols: number
  readonly rows: number
  /** The screen as escape sequences, or `null` when it cannot be taken */
  serialize(): string | null
  /** Calls `sink` with everything written to the terminal from now on; returns how to stop */
  mirror(sink: (data: string | Uint8Array) => void): () => void
  /** Text typed at the display, as `onData` carries it */
  remoteData(data: string): void
  /** A key pressed at the display, as `onKey` carries it */
  remoteKey(key: string, mods: KeyMods): void
  /** The tty's window is this size: the smallest of the displays attached to it */
  remoteResize(cols: number, rows: number): void
}

export interface KeyMods { key: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean }

export type ToOwner =
  | { t: 'hello', token: string, tty: number }
  | { t: 'data', data: string }
  | { t: 'key', key: string, mods: KeyMods }
  | { t: 'size', cols: number, rows: number }
  | { t: 'presented', id: number, result?: unknown, error?: string }
  | { t: 'bye' }

export type ToDisplay =
  | { t: 'welcome', token: string, tty: number, cols: number, rows: number, screen: string }
  | { t: 'refused', token: string, reason: string }
  | { t: 'out', data: string | Uint8Array }
  | { t: 'present', id: number, kind: string, params: Record<string, unknown> }
  | { t: 'cancel', id: number }

type ChannelFactory = (name: string) => BroadcastChannel

/** What a display does with a browser call routed to it: finishes with a result, and can be cancelled */
export interface RemoteCall {
  done: Promise<unknown>
  cancel(): void
}

interface Session {
  channel: BroadcastChannel
  stop: () => void
  tty: number
  terminal: MirroredTerminal
  size?: { cols: number, rows: number }
  /** When this display last sent input: the one the user is at is the one a browser call goes to */
  lastInput: number
  pending: Map<number, { resolve: (result: unknown) => void, reject: (error: Error) => void }>
}

/** Runs in the tab that owns the machine */
export class DisplayOwner {
  private readonly _discovery: BroadcastChannel
  private readonly _sessions = new Map<string, Session>()
  private _call = 0

  constructor(
    private readonly _store: string,
    private readonly _terminalFor: (tty: number) => MirroredTerminal | undefined | Promise<MirroredTerminal | undefined>,
    private readonly _locks: LockManager | undefined,
    private readonly _channel: ChannelFactory = name => new BroadcastChannel(name)
  ) {
    this._discovery = this._channel(displayChannelName(_store))
    this._discovery.onmessage = event => {
      const message = event.data as ToOwner
      if (message?.t === 'hello') void this.attach(message.token, message.tty)
    }
  }

  /** How many displays are attached */
  get attached() { return this._sessions.size }

  private async attach(token: string, tty: number) {
    if (typeof token !== 'string' || token.length < 8 || this._sessions.has(token)) return
    let terminal: MirroredTerminal | undefined
    try { terminal = Number.isInteger(tty) ? await this._terminalFor(tty) : undefined } catch { terminal = undefined }
    if (this._sessions.has(token)) return
    if (!terminal) { this.reply({ t: 'refused', token, reason: `tty${tty} is not running on this machine` }); return }

    const channel = this._channel(displaySessionName(this._store, token))
    // The snapshot and the subscription are taken in one go, so nothing written between them is lost or shown twice
    const screen = terminal.serialize() ?? ''
    const stop = terminal.mirror(data => channel.postMessage({ t: 'out', data } satisfies ToDisplay))
    const session: Session = { channel, stop, tty, terminal, lastInput: Date.now(), pending: new Map() }
    channel.onmessage = event => {
      const message = event.data as ToOwner
      if (message.t === 'data') { session.lastInput = Date.now(); terminal.remoteData(message.data) }
      else if (message.t === 'key') { session.lastInput = Date.now(); terminal.remoteKey(message.key, message.mods) }
      else if (message.t === 'size') { session.size = { cols: message.cols, rows: message.rows }; this.fit(tty) }
      else if (message.t === 'presented') {
        const waiting = session.pending.get(message.id)
        session.pending.delete(message.id)
        if (message.error !== undefined) waiting?.reject(new Error(message.error))
        else waiting?.resolve(message.result ?? null)
      } else if (message.t === 'bye') this.detach(token)
    }
    this._sessions.set(token, session)
    this.reply({ t: 'welcome', token, tty, cols: terminal.cols, rows: terminal.rows, screen })
    // The display holds this lock while it is open; being granted it here means the display is gone
    void this._locks?.request(displayLockName(this._store, token), () => this.detach(token)).catch(() => this.detach(token))
  }

  /** A tty with several displays is as big as the smallest, so every one of them shows all of it (as tmux does) */
  private fit(tty: number) {
    const sizes = [...this._sessions.values()].filter(s => s.tty === tty && s.size)
    const first = sizes[0]
    if (!first) return
    const cols = Math.min(...sizes.map(s => s.size!.cols))
    const rows = Math.min(...sizes.map(s => s.size!.rows))
    first.terminal.remoteResize(cols, rows)
  }

  /**
   * Has a browser call done by the display the user is at on `tty`, or `undefined` when no display is attached to it (the owner's
   * tab does it then). The call ends with the display's answer, with an error if the display goes away first, or on `cancel()`.
   */
  present(tty: number, kind: string, params: Record<string, unknown>): RemoteCall | undefined {
    let target: Session | undefined
    for (const session of this._sessions.values()) if (session.tty === tty && (!target || session.lastInput >= target.lastInput)) target = session
    if (!target) return undefined
    const session = target
    const id = ++this._call
    const done = new Promise<unknown>((resolve, reject) => { session.pending.set(id, { resolve, reject }) })
    session.channel.postMessage({ t: 'present', id, kind, params } satisfies ToDisplay)
    return {
      done,
      cancel: () => {
        if (!session.pending.delete(id)) return
        session.channel.postMessage({ t: 'cancel', id } satisfies ToDisplay)
      }
    }
  }

  private reply(message: ToDisplay) { this._discovery.postMessage(message) }

  private detach(token: string) {
    const session = this._sessions.get(token)
    if (!session) return
    this._sessions.delete(token)
    session.stop()
    session.channel.close()
    for (const waiting of session.pending.values()) waiting.reject(new Error('the display went away'))
    session.pending.clear()
    this.fit(session.tty)
  }

  close() {
    for (const token of [...this._sessions.keys()]) this.detach(token)
    this._discovery.close()
  }
}

/** What a display does with the owner's terminal: an xterm, or anything with these */
export interface DisplaySurface {
  /** Called with the owner's screen size and what is on it; again, from scratch, after a reconnect */
  open(cols: number, rows: number, screen: string): void
  write(data: string | Uint8Array): void
  /** Subscribes to typed text and to key presses. Called again after a reconnect: replace the senders, do not subscribe twice. */
  onInput(data: (text: string) => void, key: (key: string, mods: KeyMods) => void): void
  /** Subscribes to the display's own size changing and reports the size it has now. Called again after a reconnect, as `onInput` is. */
  onResize(size: (cols: number, rows: number) => void): void
  /** No machine is there (the first try was refused) or it went away; the display keeps trying */
  lost?(reason: string): void
}

export const newToken = () => {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface AttachOptions {
  locks?: LockManager
  timeoutMs?: number
  channel?: ChannelFactory
  /** Does a browser call the owner routed here (the clipboard, a notification); absent means this display cannot */
  present?: (kind: string, params: Record<string, unknown>) => RemoteCall
}

/** Runs in a tab that shows the owner's tty. Resolves to `close` once attached; rejects when the owner refuses or is not there. */
export async function attachDisplay(store: string, tty: number, surface: DisplaySurface, options: AttachOptions = {}): Promise<() => void> {
  const channelFor = options.channel ?? (name => new BroadcastChannel(name))
  const token = newToken()
  const discovery = channelFor(displayChannelName(store))

  // Presence first: the owner reads "this lock was released" as "the display is gone"
  let dropLock: (() => void) | undefined
  if (options.locks) {
    await new Promise<void>((resolve, reject) => {
      options.locks!.request(displayLockName(store, token), () => new Promise<void>(release => { dropLock = release; resolve() })).catch(reject)
    })
  }

  // Opened before announcing, so what the owner writes after taking the snapshot is held here until the screen is drawn
  const held: Array<string | Uint8Array> = []
  let drawn = false
  const calls = new Map<number, RemoteCall>()
  const session = channelFor(displaySessionName(store, token))
  session.onmessage = event => {
    const message = event.data as ToDisplay
    if (message.t === 'out') {
      if (drawn) surface.write(message.data)
      else held.push(message.data)
    } else if (message.t === 'present') {
      const id = message.id
      const reply = (answer: { result?: unknown, error?: string }) => { calls.delete(id); session.postMessage({ t: 'presented', id, ...answer } satisfies ToOwner) }
      if (!options.present) { reply({ error: 'this display cannot do that' }); return }
      try {
        const call = options.present(message.kind, message.params)
        calls.set(id, call)
        call.done.then(result => reply({ result }), (error: unknown) => reply({ error: error instanceof Error ? error.message : String(error) }))
      } catch (error) { reply({ error: error instanceof Error ? error.message : String(error) }) }
    } else if (message.t === 'cancel') {
      calls.get(message.id)?.cancel()
      calls.delete(message.id)
    }
  }

  const close = () => {
    for (const call of calls.values()) call.cancel()
    session.postMessage({ t: 'bye' } satisfies ToOwner)
    session.close()
    discovery.close()
    dropLock?.()
  }

  try {
    const welcome = await new Promise<Extract<ToDisplay, { t: 'welcome' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no machine answered; is it running in another tab?')), options.timeoutMs ?? 3000)
      discovery.onmessage = event => {
        const message = event.data as ToDisplay
        if (message?.t === 'refused' && message.token === token) { clearTimeout(timer); reject(new Error(message.reason)) }
        if (message?.t === 'welcome' && message.token === token) { clearTimeout(timer); resolve(message) }
      }
      discovery.postMessage({ t: 'hello', token, tty } satisfies ToOwner)
    })

    surface.open(welcome.cols, welcome.rows, welcome.screen)
    drawn = true
    for (const data of held.splice(0)) surface.write(data)
    surface.onInput(
      data => session.postMessage({ t: 'data', data } satisfies ToOwner),
      (key, mods) => session.postMessage({ t: 'key', key, mods } satisfies ToOwner)
    )
    surface.onResize((cols, rows) => session.postMessage({ t: 'size', cols, rows } satisfies ToOwner))
    return close
  } catch (error) {
    close()
    throw error
  }
}

export interface KeepOptions extends AttachOptions {
  /** How long to wait between tries while no machine answers (default 1000) */
  retryMs?: number
}

/**
 * A display that stays: attaches, notices when the machine goes away (the owner's tab reloaded, closed or halted: it lets go of the
 * machine lock) and attaches again when a machine answers, from a fresh screen. `close()` ends it for good.
 */
export function keepDisplay(store: string, tty: number, surface: DisplaySurface, options: KeepOptions = {}): { close(): void } {
  const stop = new AbortController()
  const wait = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    stop.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })

  /** Resolves when no tab holds the machine: a shared request is granted only once the exclusive holder has let go */
  const ownerGone = async () => {
    if (!options.locks) return new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), { once: true }))
    try { await options.locks.request(machineLockName(store), { mode: 'shared', signal: stop.signal }, () => undefined) } catch { /* aborted */ }
  }

  void (async () => {
    let reported = false
    while (!stop.signal.aborted) {
      let close: (() => void) | undefined
      try {
        close = await attachDisplay(store, tty, surface, options)
      } catch (error) {
        if (!reported) surface.lost?.(error instanceof Error ? error.message : String(error))
        reported = true
        await wait(options.retryMs ?? 1000)
        continue
      }
      await ownerGone()
      close()
      if (stop.signal.aborted) return
      surface.lost?.('the machine went away; waiting for it')
      reported = true
      await wait(options.retryMs ?? 1000)
    }
  })()

  return { close: () => stop.abort() }
}
