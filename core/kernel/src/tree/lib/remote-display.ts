/**
 * Remote displays: a second tab as a terminal of the machine the first tab runs.
 *
 * One tab owns the machine (see `machine-lock.ts`). Another tab does not run a kernel; it shows one of the owner's ttys. The owner
 * mirrors that terminal's output to it, and the display sends back what is typed, which the owner feeds in the way its own keyboard
 * is: login, shells and programs on the tty are the same as at the owner's own screen.
 *
 * Wire: a display announces itself on a discovery channel (`hello`) and the owner answers (`welcome`, with the screen as it is now).
 * The session then runs on a channel named for a random token. Presence is a Web Lock the display holds for as long as it is open, so
 * the owner learns of a closed or crashed display without a heartbeat.
 *
 * The token travels on the discovery channel, which any same-origin page can read, so this is a spike's privacy: it does not keep a
 * same-origin script out. A MessagePort brokered by the service worker would; see the notes in the plan.
 */

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
  /** The display's window is this size: the tty takes it, as the last display to speak decides (tmux would take the smallest) */
  remoteResize(cols: number, rows: number): void
}

export interface KeyMods { key: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean }

export type ToOwner =
  | { t: 'hello', token: string, tty: number }
  | { t: 'data', data: string }
  | { t: 'key', key: string, mods: KeyMods }
  | { t: 'size', cols: number, rows: number }
  | { t: 'bye' }

export type ToDisplay =
  | { t: 'welcome', token: string, tty: number, cols: number, rows: number, screen: string }
  | { t: 'refused', token: string, reason: string }
  | { t: 'out', data: string | Uint8Array }

type ChannelFactory = (name: string) => BroadcastChannel

/** Runs in the tab that owns the machine */
export class DisplayOwner {
  private readonly _discovery: BroadcastChannel
  private readonly _sessions = new Map<string, { channel: BroadcastChannel, stop: () => void }>()

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
    channel.onmessage = event => {
      const message = event.data as ToOwner
      if (message.t === 'data') terminal.remoteData(message.data)
      else if (message.t === 'key') terminal.remoteKey(message.key, message.mods)
      else if (message.t === 'size') terminal.remoteResize(message.cols, message.rows)
      else if (message.t === 'bye') this.detach(token)
    }
    this._sessions.set(token, { channel, stop })
    this.reply({ t: 'welcome', token, tty, cols: terminal.cols, rows: terminal.rows, screen })
    // The display holds this lock while it is open; being granted it here means the display is gone
    void this._locks?.request(displayLockName(this._store, token), () => this.detach(token)).catch(() => this.detach(token))
  }

  private reply(message: ToDisplay) { this._discovery.postMessage(message) }

  private detach(token: string) {
    const session = this._sessions.get(token)
    if (!session) return
    this._sessions.delete(token)
    session.stop()
    session.channel.close()
  }

  close() {
    for (const token of [...this._sessions.keys()]) this.detach(token)
    this._discovery.close()
  }
}

/** What a display does with the owner's terminal: an xterm, or anything with these */
export interface DisplaySurface {
  /** Called once with the owner's screen size and what is on it */
  open(cols: number, rows: number, screen: string): void
  write(data: string | Uint8Array): void
  /** Subscribes to typed text and to key presses */
  onInput(data: (text: string) => void, key: (key: string, mods: KeyMods) => void): void
  /** Subscribes to the display's own size changing, and reports the size it has now */
  onResize(size: (cols: number, rows: number) => void): void
}

export const newToken = () => {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Runs in a tab that shows the owner's tty. Resolves to `close` once attached; rejects when the owner refuses or is not there. */
export async function attachDisplay(
  store: string, tty: number, surface: DisplaySurface,
  options: { locks?: LockManager, timeoutMs?: number, channel?: ChannelFactory } = {}
): Promise<() => void> {
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
  const session = channelFor(displaySessionName(store, token))
  session.onmessage = event => {
    const message = event.data as ToDisplay
    if (message.t !== 'out') return
    if (drawn) surface.write(message.data)
    else held.push(message.data)
  }

  const close = () => {
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
