/**
  * @experimental
  * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
  * 
  * The Terminal class extends xterm.js to support ecmaOS-specific functionality.
  * 
 */

import ansi from 'ansi-escape-sequences'
import chalk from 'chalk'
import path from 'path'
import spinners from 'cli-spinners'

import * as emoji from '@thi.ng/emoji'
import { attach_xterm, detach_xterm, Signal } from '@zenfs/linux'
import type { Shell as KernelShell } from '#shell.ts'
import type { TTY } from '@zenfs/linux'
import { lflags } from '@zenfs/linux/uapi/abi'
import { IDisposable, ITerminalAddon, ITheme, Terminal as XTerm } from '@xterm/xterm'
import { AttachAddon } from '@xterm/addon-attach'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { ProgressAddon } from '@xterm/addon-progress'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'

import '@xterm/xterm/css/xterm.css'
import { kernelBuiltinHost, trueBuiltinNames } from '#lib/shell-builtins.ts'
import { needsMoreInput } from '@ecmaos/coreutils/lib/control-flow-parser'
import { completionMatches } from '@ecmaos/coreutils/lib/completion'
import { programmableCompletion } from '@ecmaos/coreutils/lib/shell-core/programmable-completion'
import { History } from '@ecmaos/coreutils/lib/history'
import { LineEditor, NONPRINTING_END, NONPRINTING_START, ReverseSearch, stripMarkers, visibleWidth } from '@ecmaos/coreutils/lib/line-editor'

import { Events } from '#events.ts'

import { TerminalEvents } from '@ecmaos/types'

import type {
  Dom,
  KernelContext,
  Shell,
  Terminal as ITerminal,
  TerminalOptions,
  TerminalWiring,
  TerminalResizeEvent,
  TerminalCreatedEvent,
  TerminalMountEvent,
  TerminalListenEvent,
  TerminalUnlistenEvent,
  TerminalKeyEvent,
  TerminalInputEvent,
  TerminalInterruptEvent,
  TerminalExecuteEvent,
  TerminalWriteEvent,
  TerminalWritelnEvent,
  TerminalPasteEvent,
  Users
} from '@ecmaos/types'

export enum CommandPath {
  KERNEL = 'kernel'
}

/** The exact command line an `ecmaos://kernel.execute?command=...&args=...` link asks to run. */
export interface KernelExecuteLink {
  command: string
  args: string[]
}

/**
 * Parses an `ecmaos://kernel.execute` link into the command line it would run, or `null` if the text
 * isn't one (or is malformed). Keys and values are percent-decoded; `args` is split on whitespace.
 */
export function parseKernelExecuteLink(text: string): KernelExecuteLink | null {
  const prefix = 'ecmaos://'
  if (!text.startsWith(prefix)) return null
  const rest = text.slice(prefix.length)
  const query = rest.indexOf('?')
  if (query < 0 || rest.slice(0, query) !== `${CommandPath.KERNEL}.execute`) return null

  const params: Record<string, string> = {}
  try {
    for (const pair of rest.slice(query + 1).split('&')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
    }
  } catch {
    return null // a malformed percent-escape: refuse rather than guess
  }

  const command = params['command']?.trim()
  if (!command) return null
  return { command, args: params['args']?.split(/\s+/).filter(Boolean) ?? [] }
}

/** What activating a terminal link needs from its surroundings; injectable for tests. */
export interface LinkActivationDeps {
  confirm: (message: string) => boolean | Promise<boolean>
  execute: (link: KernelExecuteLink) => unknown
  openUrl: (url: string) => void
}

const defaultLinkActivationDeps: LinkActivationDeps = {
  confirm: message => globalThis.window?.confirm?.(message) ?? false,
  execute: ({ command, args }) => {
    const kernel = globalThis.kernel
    if (kernel) return kernel.execute({ command, args, shell: kernel.shell })
  },
  openUrl: url => { globalThis.window?.open(url, '_blank', 'noopener,noreferrer') }
}

/**
 * Handles a click on a terminal link. `http(s)` links open in a new tab; an `ecmaos://kernel.execute` link shows the
 * decoded command line and runs it only if the user confirms. Resolves `true` if a command ran.
 */
export async function activateTerminalLink(text: string, deps: LinkActivationDeps = defaultLinkActivationDeps): Promise<boolean> {
  if (/^https?:\/\//.test(text)) {
    deps.openUrl(text)
    return false
  }

  const link = parseKernelExecuteLink(text)
  if (!link) return false

  const commandLine = [link.command, ...link.args].join(' ')
  if (!await deps.confirm(`A terminal link wants to run this command:\n\n${commandLine}\n\nRun it?`)) return false

  await deps.execute(link)
  return true
}

export const DefaultTerminalOptions: Omit<TerminalOptions, 'context' | 'dom' | 'users' | 'kernel'> = {
  fontFamily: 'FiraCode Nerd Font Mono, Ubuntu Mono, courier-new, courier, monospace',
  fontSize: 16,
  smoothScrollDuration: 100,
  convertEol: true,
  cursorBlink: true,
  macOptionIsMeta: true,
  allowProposedApi: true,
  // Reflow the cursor's own line on resize - shells normally handle this themselves, but ecmaOS's
  // built-in line editor (Terminal.keyHandler) is the "shell" here and does not, so without this a
  // resize can leave the prompt line wrapped incorrectly.
  reflowCursorLine: true,
  theme: {
    background: '#000000',
    foreground: '#00FF00',
    promptColor: 'green'
  },
  linkHandler: {
    allowNonHttpProtocols: true,
    activate: (_event, text) => { void activateTerminalLink(text) }
  }
}

/**
  * @experimental
  * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
  * 
  * The Terminal class extends xterm.js to support ecmaOS-specific functionality.
  * 
 */
export class Terminal extends XTerm implements ITerminal {
  private _addons: TerminalOptions['addons'] = new Map()
  private _ansi: typeof ansi = ansi
  /**
   * The line being edited. Everything that changes it goes through this; `_cmd` and `_cursorPosition` below are views
   * of it.
   */
  private _editor: LineEditor
  private _history: History
  /** Active `^R` search, if any. */
  private _search: ReverseSearch | undefined
  /** How many commands this terminal has run, for `\#` in a prompt. */
  private _commandNumber = 1
  private _shortcutListener: IDisposable | undefined
  private _events: Events
  private _ctx: KernelContext
  private _dom: Dom
  private _id: string = crypto.randomUUID()
  private _users: Users
  private _wiring?: TerminalWiring
  private _keyListener: IDisposable | undefined
  // {sigil} is '#' for root, '$' for anyone else - resolved per render, so the first prompt after a
  // non-root login is right without anything having to reset the template.
  private _promptTemplate: string = '{user}:{cwd}{sigil} '
  /** Assigned by `attachShell()` right after construction. */
  private _shell!: Shell
  private _stdin: ReadableStream<Uint8Array>
  private _stdout: WritableStream<Uint8Array>
  private _stderr: WritableStream<Uint8Array>
  private _stdinSubscribers: Set<(data: Uint8Array) => void> = new Set()
  private _multiLineMode: boolean = false
  private _multiLineBuffer: string = ''
  private _tabCompletionIndex: number = 0
  private _lastTabCommand: string = ''
  private _isTabCycling: boolean = false
  private _isMobile: boolean = false
  private _visualViewportSupported: boolean = false
  private _viewportListeners: Array<() => void> = []
  private _passwordInputElement: HTMLInputElement | null = null
  private _isResizing: boolean = false
  private _lastViewportHeight: number = 0
  private _resizeTimeout: ReturnType<typeof setTimeout> | null = null
  private _mobileInputElement: HTMLInputElement | null = null
  private _mobileInputListener: IDisposable | null = null
  private _tty: number
  private _ttySwitchHandler: ((event: KeyboardEvent) => void) | null = null
  private _resizeObserver: ResizeObserver | null = null
  /**
   * This terminal's `@zenfs/linux` TTY, once attached in `mount()`.
   *
   * Attached with `input: false`; `attachInput()` feeds the keyboard to it while a program holds the
   * terminal, and its line discipline then turns `^C` and `^Z` into signals for the foreground process.
   * Without it (the readline loop owns the keys) `keyHandler` signals `Shell.foregroundJob` directly.
   */
  private _zfsTty: TTY | undefined
  private _ttyInput: IDisposable | undefined
  private _ttyInputHolders = 0
  private _readlineActive = 0
  /** Typed while a command ran and not read by it; replayed into the line editor after the next prompt */
  private _typeahead = ''
  private _ttySavedTermios: TTY['termios'] | undefined
  /**
   * The active hardware-accelerated renderer, once loaded in `mount()`. `undefined` when running
   * the `dom` renderer, either by config or because WebGL's context was lost and this fell back.
   */
  private _webglAddon: WebglAddon | undefined
  /** Set once WebGL's context has been lost this session; see `_applyRenderer`. */
  private _fellBackFromWebgl: boolean = false

  get addons() { return this._addons as Map<string, ITerminalAddon> }
  get ansi() { return this._ansi }
  get cmd() { return this._cmd }
  get cwd() { return this._shell.cwd }
  get isMobile() { return this._isMobile }
  get emojis() { return emoji }
  get events() { return this._events }
  get id() { return this._id }
  get stdin() { return this._stdin }
  get stdout() { return this._stdout }
  get stderr() { return this._stderr }
  get tty() { return this._tty }
  /** The `@zenfs/linux` TTY this terminal is attached to, once `mount()` has run */
  get zfsTty() { return this._zfsTty }

  /**
   * Feeds raw input (`onData`) into this terminal's `@zenfs/linux` TTY so a foreground program reading fd 0 gets
   * line-discipline input (canonical/raw mode, echo, `ISIG`). While held, `keyHandler` stands down. Reference-
   * counted; returns an idempotent release. The last release hands unread typeahead back to the line editor. Mobile
   * does not use it.
   */
  attachInput(): () => void {
    const tty = this._zfsTty
    if (!tty || this._isMobile) return () => {}

    if (this._ttyInputHolders++ === 0) {
      // The line settings the session started with, restored by the last holder to release.
      this._ttySavedTermios = { ...tty.termios, cc: [...tty.termios.cc] }
      // not while `readline()` is answering a question for the kernel: what is typed then is the answer, and must not
      // also wait in the line discipline to be run as a command when the program ends
      this._ttyInput = this.onData(data => { if (!this._readlineActive) tty.receive(data) })
    }

    let released = false
    return () => {
      if (released) return
      released = true
      if (--this._ttyInputHolders > 0) return
      this._ttyInput?.dispose()
      this._ttyInput = undefined
      // `^C` and `^Z` have already thrown the queue away; what is left was typed for whoever reads next
      const ldisc = tty.ldisc as unknown as { buffer: number[], line: number[] }
      const queued = [...ldisc.buffer, ...ldisc.line]
      if (queued.length) this._typeahead += new TextDecoder().decode(new Uint8Array(queued))
      tty.ldisc.flush()
      if (this._ttySavedTermios) tty.set_termios(this._ttySavedTermios)
      this._ttySavedTermios = undefined
    }
  }

  /**
   * Fits the terminal to its container, unless the container is hidden. A hidden one measures as a few
   * columns, and text written then (a getty's prompt on a terminal nobody has switched to) wraps there
   * and reflows with the cursor in the wrong place once the terminal is shown.
   */
  private fitToContainer(): void {
    const fit = this.addons?.get('fit') as FitAddon | undefined
    if (!fit) return
    const container = this.element?.parentElement
    if (container && container.clientWidth === 0) return
    fit.fit()
  }

  /** Feeds text typed while a command ran to the line editor, key by key, as if it had been typed at the prompt */
  private async replayTypeahead(text: string): Promise<void> {
    for (const char of text) {
      const key = char === '\n' || char === '\r' ? 'Enter' : char
      const domEvent = { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent
      await this.keyHandler({ key: key === 'Enter' ? '\r' : char, domEvent })
    }
  }

  private _session?: () => void
  private _sessionEnded = false

  /**
   * Runs this terminal's own line editor as a login session, for a user whose shell is the built-in
   * one: resolves when `exit` is typed at the prompt or `^D` on an empty line, leaving the terminal
   * no longer listening. `/sbin/getty` waits on this and then asks for the next login.
   */
  runSession(): Promise<void> {
    return new Promise(resolve => {
      this._sessionEnded = false
      this._session = () => { this._session = undefined; this._shell.onExit = undefined; resolve() }
      this._shell.onExit = () => this.endSession()
      this.listen()
      // from column 0: erasing the line does not move the cursor, which may be wherever login left it
      this.write('\r' + ansi.erase.inLine(2))
      void this.drawPrompt()
      this.focus()
    })
  }

  private endSession(): void {
    if (!this._session) return
    this._sessionEnded = true
    this.unlisten()
    this.write('\nlogout\n')
    this._session()
  }

  /** Whether the `@zenfs/linux` line discipline currently owns the keyboard (see `attachInput`) */
  get ttyInputAttached() { return this._ttyInput !== undefined }

  /** The line as typed. Kept as a property because `Kernel` and the tests read and set it directly. */
  private get _cmd() { return this._editor.text }
  private set _cmd(value: string) { this._editor.set(value) }
  private get _cursorPosition() { return this._editor.cursor }
  private set _cursorPosition(value: number) { this._editor.set(this._editor.text, value) }

  get promptTemplate() { return this._promptTemplate }
  set promptTemplate(value: string) { this._promptTemplate = value }

  constructor(options: TerminalOptions & { tty?: number }) {
    super({ ...DefaultTerminalOptions, ...options })

    // xterm's `onKey`, which also hands every listener the keys a remote display sends (see `remoteKey`)
    const baseOnKey = this.onKey
    Object.defineProperty(this, 'onKey', {
      configurable: true,
      value: ((listener: (event: { key: string, domEvent: KeyboardEvent }) => unknown) => {
        const subscription = baseOnKey(listener)
        this._keyListeners.add(listener)
        return { dispose: () => { subscription.dispose(); this._keyListeners.delete(listener) } }
      }) as XTerm['onKey']
    })
    this._ctx = options.context
    this._dom = options.dom
    this._users = options.users
    this._tty = options.tty ?? 0
    globalThis.terminals?.set(this.id, this)

    // The editor reads the terminal's width and the prompt's width afresh on every operation, so a
    // resize or a prompt change (`PS1`, a new cwd, entering a continuation line) is picked up without
    // anyone telling it.
    const terminal = this
    this._editor = new LineEditor({
      write: data => this.write(data),
      get cols() { return terminal.cols },
      promptWidth: () => this.promptWidth()
    })
    this._history = new History({
      fs: () => this._shell?.context?.fs?.promises,
      file: () => path.join(this._shell?.env.get('HOME') || '/root', '.ecmash_history'),
      variable: name => this._shell?.env.get(name),
      error: message => this._ctx.log.error(message)
    })

    this._detectMobileSupport()

    // Create the primary stdin stream (terminal's own stdin)
    this._stdin = this.createSubscribedInputStream().stream

    // Create stdout stream that writes to the terminal
    this._stdout = new WritableStream({
      write: (chunk) => {
        const text = new TextDecoder().decode(chunk)
        this._writeSynchronized(text)
      }
    })

    // Create stderr stream that writes to the terminal in red
    this._stderr = new WritableStream({
      write: (chunk) => {
        const text = new TextDecoder().decode(chunk)
        this._writeSynchronized(chalk.red(text))
      }
    })

    // Connect keyboard input to all subscribers
    this.onKey(({ key }) => {
      if (key && key.length > 0) {
        const data = new TextEncoder().encode(key)
        for (const callback of this._stdinSubscribers) {
          try {
            callback(data)
          } catch {
            // Subscriber may be closed, will be cleaned up
          }
        }
      }
    })

    // Handle bell character
    this.onBell(() => {
      if (this._shell.config?.noBell) return

      const theme = { ...this.options.theme }
      theme.background = '#FFFFFF'
      this.options.theme = theme

      setTimeout(() => {
        const theme = { ...this.options.theme }
        theme.background = '#000000'
        this.options.theme = theme
      }, 100)
    })

    this._events = new Events()

    this._addons = options.addons || new Map([
      ['fit', new FitAddon()],
      ['image', new ImageAddon()],
      ['progress', new ProgressAddon()],
      ['search', new SearchAddon()],
      ['serialize', new SerializeAddon()],
      ['web-links', new WebLinksAddon()],
      ['unicode11', new Unicode11Addon()]
    ])

    for (const addon of this._addons.values()) this.loadAddon(addon)
    if (this._addons.get('unicode11')) this.unicode.activeVersion = '11'

    if (this.addons?.get('progress')) {
      const defaultBarColors = {
        0: "rgba(26,  188, 156, .9)",
        ".25": "rgba(52,  152, 219, .9)",
        ".50": "rgba(241, 196, 15,  .9)",
        ".75": "rgba(230, 126, 34,  .9)",
        "1.0": "rgba(211, 84,  0,   .9)"
      }

      const errorBarColors = {
        0: "rgba(220, 20, 60, .9)",
        ".25": "rgba(200, 0, 0, .9)",
        ".50": "rgba(178, 34, 34, .8)",
        ".75": "rgba(139, 0, 0, .8)",
        "1.0": "rgba(255, 0, 0, .7)"
      }

      const pauseBarColors = {
        0: "rgba(127, 140, 141, .9)",
        ".25": "rgba(189, 195, 199, .9)",
        ".50": "rgba(241, 196, 15,  .7)",
        ".75": "rgba(230, 126, 34, .7)",
        "1.0": "rgba(231, 76, 60,  .7)"
      }

      ;(this.addons.get('progress') as ProgressAddon).onChange(({ state, value }) => {
        switch (state) {
          case 0: // Remove
            this._dom.topbar(false)
            this._dom.topbarProgress(0)
            break
          case 1: // Set
            this._dom.topbarConfig({
              autoRun: false,
              barColors: defaultBarColors
            })
            this._dom.topbar(true)
            this._dom.topbarProgress(value / 100)
            break
          case 2: // Error
            this._dom.topbar(true)
            this._dom.topbarProgress(value / 100)
            this._dom.topbarConfig({
              autoRun: false,
              barColors: errorBarColors
            })
            break
          case 3: // Indeterminate
            this._dom.topbarConfig({ autoRun: false, barColors: defaultBarColors })
            this._dom.topbarProgress(1)
            this._dom.topbar(true)
            break
          case 4: // Pause
            this._dom.topbarConfig({
              autoRun: false,
              barColors: pauseBarColors
            })
            this._dom.topbar(true)
            break
        }
      })
    }

    this.fitToContainer()
    globalThis.addEventListener?.('resize', () => {
      this.fitToContainer()
      this.events.dispatch<TerminalResizeEvent>(TerminalEvents.RESIZE, { cols: this.cols, rows: this.rows })
    })

    this._shortcutListener = this.onKey(this.shortcutKeyHandler.bind(this))
    if (!this._isMobile) this._keyListener = this.onKey(this.keyHandler.bind(this))

    // A shell may not exist yet (Kernel.createShell constructs Terminal first, the same way
    // Kernel's own constructor does) - attachShell() does this same setup once a real one is
    // attached.
    if (options.shell) {
      this._shell = options.shell
      this.updateConfig()

      this._history.load(this._shell.credentials.uid).catch(() => {
        // Silently fail if filesystem isn't ready yet - will initialize on first use
      })
    }



    this.events.dispatch<TerminalCreatedEvent>(TerminalEvents.CREATED, { terminal: this })
    this.element?.setAttribute('enterkeyhint', 'send')
  }

  /**
   * OSC 52: lets a program read and write the system clipboard through an escape sequence. Loaded only when a
   * terminal is mounted in a page.
   */
  private async _loadClipboardAddon() {
    if (this.addons.has('clipboard')) return
    try {
      const { BrowserClipboardProvider, ClipboardAddon } = await import('@xterm/addon-clipboard')
      const addon = new ClipboardAddon(undefined, new BrowserClipboardProvider())
      this.addons.set('clipboard', addon)
      this.loadAddon(addon)
    } catch (error) {
      this._ctx.log.warn(`Clipboard addon unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  mount(element: HTMLElement) {
    void this._loadClipboardAddon()
    this.open(element)
    this.fitToContainer()
    this._applyRenderer()

    if (!this._zfsTty) {
      try {
        this._zfsTty = attach_xterm(this, { index: this._tty, input: false })
      } catch (error) {
        this._ctx.log.warn(`Failed to attach TTY ${this._tty} to @zenfs/linux: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    
    const textarea = element.querySelector('textarea')
    if (textarea) {
      textarea.addEventListener('paste', (e: ClipboardEvent) => this.paste(e.clipboardData?.getData('text/plain') || ''))
      
      if (this._isMobile) {
        textarea.setAttribute('inputmode', 'text')
        textarea.setAttribute('autocapitalize', 'off')
        textarea.setAttribute('autocorrect', 'off')
        textarea.setAttribute('spellcheck', 'false')
        
        textarea.addEventListener('focus', () => {
          setTimeout(() => this._resizeTerminalToViewport(), 50)
          setTimeout(() => this._resizeTerminalToViewport(), 200)
          setTimeout(() => this._resizeTerminalToViewport(), 500)
        })
        
        textarea.addEventListener('input', () => {
          setTimeout(() => this._scrollTerminalToBottom(), 0)
        })
      }
    }
    
    this._setupKeyboardHandling()
    
    if (this._isMobile) {
      setTimeout(() => this._resizeTerminalToViewport(), 100)
    }

    this._resizeObserver = new ResizeObserver(() => {
      this.fitToContainer()
      this.events.dispatch<TerminalResizeEvent>(TerminalEvents.RESIZE, { cols: this.cols, rows: this.rows })
    })
    this._resizeObserver.observe(element)
    
    this.events.dispatch<TerminalMountEvent>(TerminalEvents.MOUNT, { terminal: this, element })
  }

  /**
   * For a terminal nobody looks at in a page (a remote session): output goes to `write` as well as into the emulator,
   * and the
   * terminal gets its `@zenfs/linux` TTY without a DOM element to mount on. Input is fed by the caller (`input`,
   * `keyHandler`).
   */
  attachHeadless(write: (data: string | Uint8Array) => void) {
    const emulatorWrite = this.write.bind(this) as (data: string | Uint8Array, callback?: () => void) => void
    this.write = ((data: string | Uint8Array, callback?: () => void) => {
      write(data)
      return emulatorWrite(data, callback)
    }) as typeof this.write
    if (!this._zfsTty) this._zfsTty = attach_xterm(this, { index: this._tty, input: false })
  }

  attachShell(shell: Shell) {
    this._shell = shell
    this.updateConfig()
    this._applyRenderer()
    this._history.load(this._shell.credentials.uid).catch(() => {})
  }

  /** Supply the `Kernel`-level capabilities not available at construction time; see {@link TerminalWiring}. */
  wire(wiring: TerminalWiring) {
    this._wiring = wiring
  }

  updateConfig() {
    const config = this._shell.config
    if (config) {
      if (config.fontFamily) this.options.fontFamily = config.fontFamily
      if (config.fontSize) this.options.fontSize = config.fontSize
      if (config.cursorBlink !== undefined) this.options.cursorBlink = config.cursorBlink
      if (['block', 'underline', 'bar'].includes(config.cursorStyle as string)) this.options.cursorStyle = config.cursorStyle as 'block' | 'underline' | 'bar'
      if (config.smoothScrollDuration !== undefined) this.options.smoothScrollDuration = config.smoothScrollDuration
      if (config.macOptionIsMeta !== undefined) this.options.macOptionIsMeta = config.macOptionIsMeta
      
      if (config.theme) {
        this.options.theme = { ...this.options.theme, ...config.theme }
      }
    }

    this.fitToContainer()
    if (this.element) this._applyRenderer()
  }

  /**
   * Loads or unloads the WebGL renderer to match `shell.config.renderer` (`dom` is the fallback). Does nothing after
   * a WebGL context loss, which falls back to `dom` until remount.
   */
  private _applyRenderer() {
    // this._shell may not exist yet - see the constructor's doc comment on _shell for why.
    const wantsWebgl = this._shell?.config?.renderer !== 'dom' && !this._fellBackFromWebgl

    if (!wantsWebgl) {
      this._webglAddon?.dispose()
      this._webglAddon = undefined
      return
    }

    if (this._webglAddon) return

    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        this._ctx.log.warn(`Terminal ${this._id} lost its WebGL context; falling back to the DOM renderer`)
        this._fellBackFromWebgl = true
        this._webglAddon?.dispose()
        this._webglAddon = undefined
      })

      this.loadAddon(webgl)
      this._webglAddon = webgl
    } catch (error) {
      this._ctx.log.warn(`Failed to load the WebGL renderer, falling back to the DOM renderer: ${error instanceof Error ? error.message : String(error)}`)
      this._fellBackFromWebgl = true
    }
  }

  /**
   * Move the cursor to the start of the previous word (`left`) or the start of the next word
   * (`right`), the readline/shell convention for Option+Arrow (macOS) and Ctrl+Arrow (elsewhere).
   * Word boundaries follow whitespace, matching bash's default `word-boundary` behavior.
   */
  /** Writes a chunk atomically using synchronized output (DEC mode 2026), so large writes do not tear. */
  private _writeSynchronized(text: string) {
    this.write(`\x1b[?2026h${text}\x1b[?2026l`)
  }

  hide() {
    if (this.element) this.element.style.display = 'none'
  }

  show() {
    if (this.element) this.element.style.display = 'block'
  }

  dispose() {
    // Not in `unlisten()`: this is the handler behind `Ctrl+Shift+F1`, which re-listens a terminal, so it must
    // outlive `unlisten`.
    try { this._shortcutListener?.dispose() } catch { /* already disposed */ }
    this._shortcutListener = undefined
    this._cleanupViewportListeners()
    this._webglAddon?.dispose()
    this._webglAddon = undefined
    if (this._zfsTty) {
      detach_xterm(this._zfsTty)
      this._zfsTty = undefined
    }
    if (this._resizeTimeout) {
      clearTimeout(this._resizeTimeout)
      this._resizeTimeout = null
    }
    if (this._passwordInputElement) {
      this._passwordInputElement.remove()
      this._passwordInputElement = null
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect()
      this._resizeObserver = null
    }
    this._dom.disableMobileControls()
    super.dispose()
  }

  private _cleanupViewportListeners() {
    for (const cleanup of this._viewportListeners) {
      try {
        cleanup()
      } catch (error) {
        console.warn('Error cleaning up viewport listener:', error)
      }
    }
    this._viewportListeners = []
  }

  createSpecialLink(uri: string, text: string) {
    return `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`
  }

  progress(state: string | number, value: number) {
    this.write(`\x1b]9;4;${state};${value}\x07`)
  }

  connect(socket: WebSocket) {
    this.loadAddon(new AttachAddon(socket))
  }

  listen() {
    this.unlisten()
    
    if (this._isMobile) {
      this._setupMobileInput()
    } else {
      if (this.element) {
        this._ttySwitchHandler = async (event: KeyboardEvent) => {
          if (event.ctrlKey && event.shiftKey) {
            // Only TTYs 0-7 exist, matching xterm_driver's fixed lines: 8
            const codeMatch = event.code.match(/^Digit([0-7])$/)
            if (codeMatch && codeMatch[1]) {
              event.preventDefault()
              event.stopPropagation()
              event.stopImmediatePropagation()
              const ttyNumber = parseInt(codeMatch[1])
              if (this._wiring) {
                try {
                  await this._wiring.switchTty(ttyNumber)
                } catch (err) {
                  console.error('Failed to switch TTY:', err)
                }
              }
            }
          }
        }
        
        this.element.addEventListener('keydown', this._ttySwitchHandler, true)
      }
      
      this._keyListener = this.onKey(this.keyHandler.bind(this))
    }
    
    this.events.dispatch<TerminalListenEvent>(TerminalEvents.LISTEN, { terminal: this })
  }
  
  private _setupMobileInput() {
    if (this._mobileInputElement) {
      this._mobileInputElement.remove()
    }
    
    const mobileInput = document.createElement('input')
    mobileInput.type = 'text'
    mobileInput.style.position = 'fixed'
    mobileInput.style.top = '0'
    mobileInput.style.left = '0'
    mobileInput.style.width = '1px'
    mobileInput.style.height = '1px'
    mobileInput.style.opacity = '0'
    mobileInput.style.pointerEvents = 'auto'
    mobileInput.style.zIndex = '-1'
    mobileInput.setAttribute('inputmode', 'text')
    mobileInput.setAttribute('autocapitalize', 'off')
    mobileInput.setAttribute('autocorrect', 'off')
    mobileInput.setAttribute('spellcheck', 'false')
    mobileInput.setAttribute('enterkeyhint', 'send')
    
    document.body.appendChild(mobileInput)
    this._mobileInputElement = mobileInput
    
    let lastValue = ''
    
    const handleInput = () => {
      const currentValue = mobileInput.value
      const diff = currentValue.length - lastValue.length
      
      if (diff > 0) {
        const newChars = currentValue.slice(lastValue.length)
        for (const char of newChars) {
          const fakeEvent = new KeyboardEvent('keydown', {
            key: char,
            code: `Key${char.toUpperCase()}`,
            bubbles: true,
            cancelable: true
          })
          Object.defineProperty(fakeEvent, 'target', { value: mobileInput, enumerable: true })
          this.keyHandler({ key: char, domEvent: fakeEvent as KeyboardEvent })
        }
      } else if (diff < 0) {
        const backspaceEvent = new KeyboardEvent('keydown', {
          key: 'Backspace',
          code: 'Backspace',
          bubbles: true,
          cancelable: true
        })
        Object.defineProperty(backspaceEvent, 'target', { value: mobileInput, enumerable: true })
        this.keyHandler({ key: '\b', domEvent: backspaceEvent as KeyboardEvent })
      }
      
      lastValue = currentValue
    }
    
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.target !== mobileInput) return
      
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true
        })
        Object.defineProperty(enterEvent, 'target', { value: mobileInput, enumerable: true })
        
        await this.keyHandler({ key: '\r', domEvent: enterEvent as KeyboardEvent })
        
        setTimeout(() => {
          mobileInput.value = ''
          lastValue = ''
        }, 50)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        e.stopPropagation()
        
        const fakeEvent = new KeyboardEvent('keydown', {
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          bubbles: true,
          cancelable: true
        })
        Object.defineProperty(fakeEvent, 'target', { value: mobileInput, enumerable: true })
        
        await this.keyHandler({ key: e.key, domEvent: fakeEvent as KeyboardEvent })
        
        setTimeout(() => {
          mobileInput.value = this._cmd
          lastValue = this._cmd
          const cursorPos = this._cursorPosition
          if (mobileInput.setSelectionRange) {
            mobileInput.setSelectionRange(cursorPos, cursorPos)
          }
        }, 0)
      } else if (e.ctrlKey && (e.key === 'c' || e.key === 'l' || e.key === 'v')) {
        e.preventDefault()
        e.stopPropagation()
        
        const fakeEvent = new KeyboardEvent('keydown', {
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          bubbles: true,
          cancelable: true
        })
        Object.defineProperty(fakeEvent, 'target', { value: mobileInput, enumerable: true })
        
        await this.keyHandler({ key: e.key, domEvent: fakeEvent as KeyboardEvent })
      }
    }
    
    mobileInput.addEventListener('input', handleInput)
    mobileInput.addEventListener('keydown', handleKeyDown)
    
    mobileInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (mobileInput && document.body.contains(mobileInput) && this._keyListener !== undefined) {
          mobileInput.focus()
        }
      }, 100)
    })
    
    setTimeout(() => {
      mobileInput.focus()
    }, 100)
    
    this._mobileInputListener = {
      dispose: () => {
        mobileInput.removeEventListener('input', handleInput)
        mobileInput.removeEventListener('keydown', handleKeyDown)
        if (mobileInput && document.body.contains(mobileInput)) {
          mobileInput.remove()
        }
        this._mobileInputElement = null
      }
    }

    this._dom.enableMobileControls((key: string, code: string) => {
      const fakeEvent = new KeyboardEvent('keydown', {
        key,
        code,
        bubbles: true,
        cancelable: true
      })
      Object.defineProperty(fakeEvent, 'target', { value: mobileInput, enumerable: true })
      this.keyHandler({ key, domEvent: fakeEvent })
    })
  }

  get listening() {
    return this._keyListener !== undefined || this._mobileInputListener != null
  }

  unlisten() {
    try { this._keyListener?.dispose() } catch { /* already disposed */ }
    try { this._mobileInputListener?.dispose() } catch { /* already disposed */ }
    // Remove TTY switch handler
    if (this.element && this._ttySwitchHandler) {
      this.element.removeEventListener('keydown', this._ttySwitchHandler, true)
      this._ttySwitchHandler = null
    }
    this._keyListener = undefined
    this._mobileInputListener = null
    this._dom.disableMobileControls()
    this.events.dispatch<TerminalUnlistenEvent>(TerminalEvents.UNLISTEN, { terminal: this })
  }

  // Keyboard shortcuts are fixed
  async shortcutKeyHandler({ domEvent }: { domEvent: KeyboardEvent }) {
    this.events.dispatch<TerminalKeyEvent>(TerminalEvents.KEY, { key: domEvent.key, domEvent })

    if (!domEvent.ctrlKey && !domEvent.shiftKey) {
      switch (domEvent.key) {
        case 'F11': document.documentElement.requestFullscreen(); break
      }
    }

    if (domEvent.ctrlKey && domEvent.shiftKey) {
      switch (domEvent.key) {
        case 'F1': this.listen(); break
        case 'F2': this.unlisten(); break
        case 'Delete': this._wiring?.reboot(); break
      }
    }
  }

  async readline(prompt: string = '', hide: boolean = false, noListen: boolean = false) {
    if (this._isMobile) return this._readlineWithDomInput(prompt, noListen, hide)

    // A private editor for this one call: the prompt's own line (`_editor`) is untouched, which is
    // what lets `readline()` run while a command is executing. `hide` turns the screen off entirely
    // rather than masking it, so nothing about a password - its length included - is drawn.
    const terminal = this
    const editor = new LineEditor({
      write: data => { if (!hide) this.write(data) },
      get cols() { return terminal.cols },
      promptWidth: () => visibleWidth(prompt)
    })

    const wasListening = this._keyListener !== undefined
    this.unlisten()

    // `unlisten()` does not stop `onData`, so a foreground program holding `attachInput()` would still have its input
    // echoed by the line discipline; echo is turned off for hidden input.
    const tty = this._zfsTty
    const restoreTtyEcho = hide && tty && this._ttyInput
      ? (() => {
          const lflag = tty.termios.lflag
          if ((lflag & lflags.ECHO) === 0) return undefined
          tty.set_termios({ lflag: lflag & ~lflags.ECHO })
          return () => tty.set_termios({ lflag })
        })()
      : undefined

    this.write(stripMarkers(prompt))
    this.focus()

    this._readlineActive++
    const result = await new Promise<string>((resolve) => {
      const disposable = this.onKey(({ key, domEvent }) => {
        if (domEvent.target && this._passwordInputElement && domEvent.target === this._passwordInputElement) {
          return
        }

        domEvent.preventDefault()
        domEvent.stopPropagation()

        switch (domEvent.key) {
          case 'Enter': {
            disposable.dispose()
            this.write('\n')
            resolve(editor.text)
            return
          }
          case 'Escape':
            disposable.dispose()
            resolve('')
            return
        }

        this._editKey(editor, key, domEvent)
      })
    })

    this._readlineActive--
    restoreTtyEcho?.()
    if (wasListening && !noListen) this.listen()
    return result
  }

  spinner(spinner: keyof typeof spinners, prefix?: string, suffix?: string) {
    const { interval, frames } = spinners[spinner]
    if (!interval || !frames) throw new Error(this._ctx.i18n.ns.terminal('invalidSpinner'))

    return new Spinner(this, interval, frames, prefix, suffix)
  }

  /**
   * Parses a PS1-like format. Placeholders: `\u` user, `\h` host, `\w` cwd, `\W` cwd basename, `\$` `$` or `#`, `\s`
   * shell; `\C{color}` colors, `\C{reset}` or `\C{default}`; `\[...\]` marks non-printing sequences.
   */
  private parsePromptFormat(format: string): string {
    const user = this._users.get(this._shell.credentials.euid ?? 0)
    const username = user?.username || 'root'
    const hostname = globalThis.location?.hostname || 'localhost'
    const shell = this._shell.env.get('SHELL') || 'ecmaos'
    const isRoot = (user?.uid ?? 0) === 0
    const promptChar = isRoot ? '#' : '$'
    
    // Get basename of cwd
    const cwdBasename = path.basename(this.cwd) || '/'
    const cwdFull = this.cwd

    let output = ''
    let i = 0

    // Color mapping
    const colorMap: Record<string, string> = {
      'black': '\x1b[30m',
      'red': '\x1b[31m',
      'green': '\x1b[32m',
      'yellow': '\x1b[33m',
      'blue': '\x1b[34m',
      'magenta': '\x1b[35m',
      'cyan': '\x1b[36m',
      'white': '\x1b[37m',
      'gray': '\x1b[90m',
      'grey': '\x1b[90m',
      'reset': '\x1b[0m',
      'default': '\x1b[0m',
      'bold': '\x1b[1m',
      'dim': '\x1b[2m',
      'italic': '\x1b[3m',
      'underline': '\x1b[4m',
    }

    // Process character by character
    while (i < format.length) {
      const char = format[i]
      const nextChar = format[i + 1]

      // Handle escape sequences
      if (char === '\\' && nextChar) {
        switch (nextChar) {
          case 'u': // username
            output += chalk.white(username)
            i += 2
            break
          case 'h': // hostname
            output += chalk.white(hostname)
            i += 2
            break
          case 'w': // full working directory
            output += chalk.cyan(cwdFull)
            i += 2
            break
          case 'W': // basename of working directory
            output += chalk.cyan(cwdBasename)
            i += 2
            break
          case '$': // prompt character ($ or #)
            output += promptChar
            i += 2
            break
          case 's': // shell name
            output += chalk.white(shell)
            i += 2
            break
          case 'n': // newline
            output += '\n'
            i += 2
            break
          case 'C': // Color: \C{colorname}
            if (format[i + 2] === '{') {
              const endBrace = format.indexOf('}', i + 3)
              if (endBrace !== -1) {
                const colorName = format.substring(i + 3, endBrace)
                const colorCode = colorMap[colorName.toLowerCase()] || ''
                output += colorCode
                i = endBrace + 1 // Skip to after the closing brace
                break
              }
            }
            // Fall through if invalid \C format
            output += char
            i++
            break
          case '[': // start of a run that occupies no columns
            output += NONPRINTING_START
            i += 2
            break
          case ']':
            output += NONPRINTING_END
            i += 2
            break
          case 't': // 24-hour time, HH:MM:SS
            output += new Date().toTimeString().slice(0, 8)
            i += 2
            break
          case 'T': { // 12-hour time, HH:MM:SS
            const hours = new Date().getHours() % 12 || 12
            output += String(hours).padStart(2, '0') + new Date().toTimeString().slice(2, 8)
            i += 2
            break
          }
          case 'A': // 24-hour time, HH:MM
            output += new Date().toTimeString().slice(0, 5)
            i += 2
            break
          case 'd': // date, "Tue May 26"
            output += new Date().toDateString().slice(0, 10)
            i += 2
            break
          case '!': // history number of this command
            output += String(this._history.length(this._shell.credentials.uid) + 1)
            i += 2
            break
          case '#': // command number
            output += String(this._commandNumber)
            i += 2
            break
          case 'j': // jobs the shell is managing
            output += String(this._shell.listJobs().filter(job => job.status !== 'done').length)
            i += 2
            break
          case 'e': // escape, for hand-written color codes; wrap them in \[ \] to keep them out of the width
            output += '\x1b'
            i += 2
            break
          case 'a': // bell
            output += '\x07'
            i += 2
            break
          case 'r':
            output += '\r'
            i += 2
            break
          case '\\':
            output += '\\'
            i += 2
            break
          default:
            // Unknown escape, output as-is
            output += char
            i++
            break
        }
      } else {
        output += char
        i++
      }
    }

    return output
  }

  /**
   * The prompt to write. It is {@link _rawPrompt} without the non-printing markers, which exist only
   * so {@link promptWidth} can tell how many columns the text occupies.
   */
  prompt(text?: string): string {
    return stripMarkers(this._rawPrompt(text))
  }

  /** Columns the current prompt line occupies before the cursor: `$PS1`, or `$PS2` while continuing. */
  promptWidth(): number {
    return visibleWidth(this._multiLineMode ? this._rawContinuation() : this._rawPrompt())
  }

  /** `$PS2`, the prompt for the second and later lines of a command. Defaults to `> `. */
  continuationPrompt(): string {
    return stripMarkers(this._rawContinuation())
  }

  private _rawContinuation(): string {
    const ps2 = this._shell?.env.get('PS2')
    if (ps2 === undefined) return '> '
    try { return this.parsePromptFormat(ps2) } catch { return ps2 }
  }

  /** What precedes the line being edited: `$PS1` normally, `$PS2` on a continuation line. */
  private _linePrefix(): string {
    return this._multiLineMode ? this.continuationPrompt() : this.prompt()
  }

  /** A command line as it is drawn: everything from the first `#` dimmed, as a comment. */
  private _renderCommand(text: string): string {
    const parts = text.split('#')
    return parts.length > 1 ? parts[0] + chalk.gray('#' + parts.slice(1).join('#')) : text
  }

  /**
   * The prompt with its non-printing markers still in place. Loads `PROMPT` from the environment if
   * one is set.
   */
  private _rawPrompt(text?: string): string {
    // Try to get PROMPT from environment
    const envPrompt = this._shell.env.get('PROMPT')
    const hasEnvPrompt = envPrompt && envPrompt.trim().length > 0
    
    // Use provided text, env PROMPT, or fall back to template
    const promptFormat = text || (hasEnvPrompt ? envPrompt : this._promptTemplate)

    // If using old format with {placeholders}, convert to new format
    if (promptFormat.includes('{') && !hasEnvPrompt && !text) {
      const user = this._users.get(this._shell.credentials.euid ?? 0)
      const promptColor = (this.options.theme as ITheme & { promptColor?: string })?.promptColor || 'green'
      const colorFn = promptColor.startsWith('#') 
        ? chalk.hex(promptColor) 
        : (chalk as unknown as Record<string, (s: string) => string>)[promptColor] || chalk.green
      return colorFn(promptFormat
        .replace('{cwd}', chalk.cyan(this.cwd))
        .replace('{uid}', chalk.white(user?.uid.toString() || ''))
        .replace('{gid}', chalk.white(user?.gid.toString() || ''))
        .replace('{user}', chalk.white(user?.username || ''))
        .replace('{sigil}', (this._shell.credentials.euid ?? 0) === 0 ? '#' : '$'))
    }

    // Parse the PS1-like format
    try {
      return this.parsePromptFormat(promptFormat)
    } catch {
      // Fall back to default if parsing fails
      const user = this._users.get(this._shell.credentials.euid ?? 0)
      const defaultPrompt = user?.uid === 0 ? '{user}:{cwd}# ' : '{user}:{cwd}$ '
      const promptColor = (this.options.theme as ITheme & { promptColor?: string })?.promptColor || 'green'
      const colorFn = promptColor.startsWith('#') 
        ? chalk.hex(promptColor) 
        : (chalk as unknown as Record<string, (s: string) => string>)[promptColor] || chalk.green
      return colorFn(defaultPrompt
        .replace('{cwd}', chalk.cyan(this.cwd))
        .replace('{user}', chalk.white(user?.username || '')))
    }
  }

  override async paste(data?: string) {
    const clip = data ? data : await navigator.clipboard.readText()
    // Newlines become spaces: the editor models one logical line, and a raw newline written to the
    // screen moved the cursor without the model knowing, so every repaint after it landed wrong.
    this._editor.insert(clip.replace(/\r?\n/g, ' '))
    this.events.dispatch<TerminalPasteEvent>(TerminalEvents.PASTE, { text: clip })
    this.events.dispatch<TerminalInputEvent>(TerminalEvents.INPUT, { terminal: this, data: clip })
  }

  /**
   * Draws the primary prompt the way bash does: finished-job notices first, then `PROMPT_COMMAND`, then
   * `$PS1`. Without a `PROMPT_COMMAND` it is one synchronous write, as before.
   */
  private async drawPrompt(lead = ''): Promise<void> {
    if (!this._shell?.hasPromptCommand?.()) { this.write(lead + this.jobNotices() + this.prompt()); return }
    this.write(lead + this.jobNotices())
    try { await this._shell.runPromptCommand() } catch { /* a broken PROMPT_COMMAND must not take the prompt with it */ }
    this.write(this.prompt())
  }

  /** Finished background jobs, reported once as bash does just before it draws PS1. */
  private jobNotices(): string {
    const lines = this._shell?.takeJobNotifications?.() ?? []
    return lines.map(line => line + '\r\n').join('')
  }

  /**
   * Bookkeeping for a foreground job whose process was stopped (`^Z`): it gives up the terminal, is marked stopped
   * and control returns to the prompt. Idempotent.
   */
  /** Counts jobs stopped with `^Z`; see the prompt drawn after a command finishes. */
  private _stopEpoch = 0

  foregroundStopped() {
    const job = this._shell?.foregroundJob
    if (job && job.status !== 'stopped') {
      for (const process of job.processes) process.setForeground?.(false)
      job.status = 'stopped'
      this.write(`\n[${job.id}]+  Stopped                 ${job.commandLine}\n`)
      this._stopEpoch++
    }

    this._editor.reset()
    this.unlisten()
    this.write(this.prompt())
    this.listen()
  }

  /**
   * The editing keys, shared by the prompt and `readline()`. Emacs bindings: `^A`/`^E`, `^B`/`^F`, `^D`, `^K`/`^U`,
   * `^W`, `^Y`, and `Alt-B`/`Alt-F`/`Alt-D`/`Alt-Backspace`. Killed text goes on a ring. Returns whether it handled
   * the key.
   */
  private _editKey(editor: LineEditor, key: string, domEvent: KeyboardEvent): boolean {
    const name = domEvent.key
    const letter = name.length === 1 ? name.toLowerCase() : ''

    // AltGr arrives as Ctrl+Alt on some layouts and is how `@`, `{` and `\` are typed there, so a
    // Ctrl+Alt chord is text, not a binding.
    if (domEvent.ctrlKey && !domEvent.altKey) {
      // A chord we bind must not also reach the browser (`^A` select-all, `^U` view-source, `^K`
      // the address bar). Harmless for one we do not, and the call is skipped by synthetic events.
      if ('abfdkuwye'.includes(letter) && letter) domEvent.preventDefault?.()
      switch (letter) {
        case 'a': editor.home(); return true
        case 'e': editor.end(); return true
        case 'b': editor.left(); return true
        case 'f': editor.right(); return true
        case 'd':
          // On an empty line `^D` is end of input: it ends a login session, as in a real shell.
          if (this._session && editor.text === '') { this.endSession(); return true }
          editor.deleteForward()
          return true
        case 'k': editor.killToEnd(); return true
        case 'u': editor.killToStart(); return true
        case 'w': editor.killWordBackward(); return true
        case 'y': editor.yank(); return true
      }
    }

    if (domEvent.altKey && !domEvent.ctrlKey) {
      switch (name) {
        case 'ArrowLeft': case 'b': editor.wordLeft(); return true
        case 'ArrowRight': case 'f': editor.wordRight(); return true
        case 'd': editor.killWordForward(); return true
        case 'Backspace': editor.killWordBackward(); return true
      }
    }

    switch (name) {
      case 'Backspace': editor.backspace(); return true
      case 'Delete': editor.deleteForward(); return true
      case 'ArrowLeft': editor.left(); return true
      case 'ArrowRight': editor.right(); return true
      case 'Home': editor.home(); return true
      case 'End': editor.end(); return true
    }

    // Any other single printable character; an unbound control character is ignored.
    if ((!domEvent.ctrlKey || domEvent.altKey) && !domEvent.metaKey) {
      if ([...key].length === 1 && key >= ' ' && key !== '\x7f') {
        editor.insert(key)
        return true
      }
    }
    return false
  }

  /** Recalls the previous (`-1`) or next (`+1`) history entry into the line. */
  private async _recall(direction: -1 | 1) {
    const uid = this._shell.credentials.uid
    await this._history.load(uid)

    const target = this._history.position(uid) + direction
    const length = this._history.length(uid)
    if (target < 0 || target > length) return

    this._history.setPosition(uid, target)
    const text = target === length ? '' : this._history.get(uid, target) ?? ''
    this._editor.replace(text, line => this._linePrefix() + this._renderCommand(line))
  }

  /** Draws the `^R` search line in place of the prompt. */
  private _drawSearch(first = false) {
    if (!this._search) return
    if (first) this._editor.eraseBlock()
    else this.write('\r\x1b[2K')
    this.write(this._search.render())
  }

  /** Leaves `^R`, putting `text` back on the prompt line. */
  private _endSearch(text: string) {
    this._search = undefined
    this.write('\r\x1b[2K')
    this._editor.set(text)
    this.write(this._linePrefix() + this._renderCommand(text))
  }

  /**
   * Keys while `^R` is active: printable characters extend the query, `^R` steps to an older match,
   * Backspace shortens it, Enter runs the match, and `^G`/Escape cancel back to what was typed. Any
   * other key accepts the match into the line and then does what it normally would.
   */
  private async _searchKey(key: string, domEvent: KeyboardEvent): Promise<void> {
    const search = this._search
    if (!search) return
    const name = domEvent.key
    const letter = name.length === 1 ? name.toLowerCase() : ''

    if (domEvent.ctrlKey && (letter === 'r')) { search.next(); return this._drawSearch() }
    if (domEvent.ctrlKey && (letter === 'g' || letter === 'c') || name === 'Escape') {
      return this._endSearch(search.originalText)
    }
    if (name === 'Backspace') { search.backspace(); return this._drawSearch() }
    if (!domEvent.ctrlKey && !domEvent.altKey && [...key].length === 1 && key >= ' ') {
      search.type(key)
      return this._drawSearch()
    }

    this._endSearch(search.match ?? search.originalText)
    return this.keyHandler({ key, domEvent })
  }

  async keyHandler({ key, domEvent }: { key: string; domEvent: KeyboardEvent }): Promise<void> {
    const keyName = domEvent.key
    if (!key && !keyName) return
    if (domEvent.ctrlKey && domEvent.shiftKey) {
      if (keyName === 'F1' || keyName === 'F2') return // Ignore listen/unlisten keys
    }

    this.events.dispatch<TerminalKeyEvent>(TerminalEvents.KEY, { key, domEvent })

    if (this._ttyInput) return // the line discipline owns the keyboard; see `attachInput`

    if (this._search) return this._searchKey(key, domEvent)

    if (domEvent.ctrlKey) {
      switch (keyName) {
        case 'c': {
          this.events.dispatch<TerminalInterruptEvent>(TerminalEvents.INTERRUPT, { terminal: this })

          // Signal the foreground job's processes. A job with no process (a shell builtin) cannot be
          // interrupted; `^C` still resets the line editor below, which frees the prompt.
          const job = this._shell?.foregroundJob
          if (job) for (const process of job.processes) process.kill(Signal.INT)
          // `notifyInterrupted` also stops the rest of a `;` list. This branch runs only when no line discipline is
          // attached; otherwise `Kernel.executeViaExecve` calls it.
          void this._shell?.notifyInterrupted()

          this._editor.reset()
          this._multiLineMode = false
          this._multiLineBuffer = ''
          this.unlisten()
          await this.drawPrompt('\n')
          this.listen()
          return
        }
        case 'z': {
          // `^Z` with no line discipline attached: SIGTSTP the foreground job's real process(es), then
          // do the same bookkeeping `foregroundStopped` does for a process the line discipline stopped.
          const job = this._shell?.foregroundJob
          if (job) for (const process of job.processes) process.kill(Signal.TSTP)
          if (job?.status !== 'stopped') this.foregroundStopped()
          return
        }
        case 'l':
          return this.clear()
        case 'v':
          return this.paste()
        case 'r': {
          domEvent.preventDefault?.() // or the browser reloads the page
          const uid = this._shell.credentials.uid
          await this._history.load(uid)
          this._search = new ReverseSearch(this._history.entries(uid), this._editor.text)
          return this._drawSearch(true)
        }
        case 'Escape':
          return this.write(ansi.erase.display(2) + ansi.cursor.position() + this.prompt())
      }
    }

    this._isTabCycling = keyName === 'Tab' ? this._isTabCycling : false

    if (keyName !== 'Enter' && keyName !== 'Tab' && keyName !== 'ArrowUp' && keyName !== 'ArrowDown') {
      if (this._editKey(this._editor, key, domEvent)) return
    }

    switch (keyName) {
      case 'Enter': {
        const editor = this._editor
        if (editor.text.trim().endsWith('\\')) {
          // A backslash-newline is *removed*, not turned into a newline: `echo one \` then `two`
          // is the single line `echo one two`, as in every real shell. Joining with `\n` instead
          // made it two separate commands, so the continuation silently ran `two` as its own.
          this._multiLineBuffer += editor.text.replace(/\\\s*$/, '')
          this._multiLineMode = true
          editor.reset()
          this.write('\n' + this.continuationPrompt())
          break
        }

        // The line as it would be if this Enter ended it. The shell grammar decides whether that is complete; an open
        // heredoc or block continues, a syntax error does not (`needsMoreInput`).
        const candidate = this._multiLineMode ? this._multiLineBuffer + editor.text : editor.text
        if (candidate.trim().length > 0 && needsMoreInput(candidate)) {
          this._multiLineBuffer = candidate + '\n'
          this._multiLineMode = true
          editor.reset()
          this.write('\n' + this.continuationPrompt())
          break
        }

        if (this._multiLineMode) {
          this._multiLineBuffer += editor.text
          editor.set(this._multiLineBuffer)
          this._multiLineMode = false
          this._multiLineBuffer = ''
        }

        this.write('\n')

        if (editor.text.trim().length > 0) {
          const cmdToExecute = editor.text
          const uid = this._shell.credentials.uid

          editor.reset()

          // `HISTCONTROL` decides whether it is kept (a leading space, a repeat of the last line);
          // either way the position returns to "the line being typed".
          await this._history.add(uid, cmdToExecute)
          this._commandNumber++

          const epoch = this._stopEpoch
          this._typeahead = ''
          try {
            this.events.dispatch<TerminalExecuteEvent>(TerminalEvents.EXECUTE, { terminal: this, command: cmdToExecute })
            await this._shell.execute(cmdToExecute)
          } catch (error) {
            this.writeln(chalk.red(`${error}`))
          } finally {
            // A command that was stopped (`^Z`) already got its prompt back then. When it finally
            // finishes, after an `fg` and a `^C` say, the `fg` that resumed it draws the prompt; a
            // second one here landed after the first, indented by its width.
            if (epoch === this._stopEpoch && !this._sessionEnded) {
              // `read` and `select` take the keyboard with `readline(..., noListen)`, so the prompt takes it back
              if (this._keyListener === undefined) this.listen()
              this._editor.reset()
              await this.drawPrompt(this.promptLead())
              const typeahead = this._typeahead
              this._typeahead = ''
              if (typeahead) await this.replayTypeahead(typeahead)
            }
          }
        } else {
          editor.reset()
          await this.drawPrompt(this.promptLead())
        }
        break
      }
      case 'ArrowUp':
        await this._recall(-1)
        break
      case 'ArrowDown':
        await this._recall(1)
        break
      case 'Tab': {
        domEvent.preventDefault()

        // If this is a new tab completion attempt (not cycling)
        if (!this._isTabCycling) {
          this._tabCompletionIndex = -1 // Start at -1 so first increment gets us to 0
          this._lastTabCommand = this._editor.text
          this._isTabCycling = true
        }

        // A line ending in `/` is completed like any other: every entry matches, and Tab cycles through them.
        const matches = await this.getCompletionMatches(this._lastTabCommand) // Use original command for matches
        if (matches.length > 0) {
          this._tabCompletionIndex = (this._tabCompletionIndex + 1) % matches.length
          const next = matches[this._tabCompletionIndex] || ''
          this._editor.replace(next, line => this._linePrefix() + this._renderCommand(line))
        }
        break
      }
    }
  }

  private readonly _mirrors = new Set<(data: string | Uint8Array) => void>()

  /**
   * Calls `sink` with everything written to this terminal from now on (a remote display, see `lib/remote-
   * display.ts`); returns how to stop
   */
  mirror(sink: (data: string | Uint8Array) => void): () => void {
    this._mirrors.add(sink)
    return () => { this._mirrors.delete(sink) }
  }

  /** Text typed at a remote display: what `onData` carries, so the line discipline of a foreground program sees it */
  remoteData(data: string): void {
    this.input(data, true)
  }

  /** A remote display's window size: the terminal takes it, and its tty's window size follows */
  remoteResize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && (cols !== this.cols || rows !== this.rows)) this.resize(cols, rows)
  }

  /** A key pressed at a remote display: what `onKey` carries, so the line editor sees it */
  remoteKey(key: string, mods: { key: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean }): void {
    const domEvent = { key: mods.key, ctrlKey: mods.ctrl, altKey: mods.alt, shiftKey: mods.shift, metaKey: mods.meta, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent
    // to every `onKey` listener, as the keyboard does: the line editor, but also a password prompt or a program
    // reading keys, which subscribe themselves
    for (const listener of [...this._keyListeners]) listener({ key, domEvent })
  }

  private readonly _keyListeners = new Set<(event: { key: string, domEvent: KeyboardEvent }) => unknown>()

  serialize() {
    if (this.addons?.get('serialize')) return (this.addons.get('serialize') as SerializeAddon).serialize()
    else return null
  }

  /** Whether what was last written left the cursor at the start of a line, so a prompt can be drawn there. */
  private _atLineStart = true

  private noteOutput(data: string | Uint8Array, newline: boolean): void {
    // bytes may come from another realm (the tty driver's, under the tests' DOM), where `instanceof Uint8Array` is false
    const text = (typeof data === 'string' ? data : new TextDecoder().decode(data))
      // control sequences move or style the cursor and print nothing
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    if (text.length > 0 || newline) this._atLineStart = newline || /[\r\n]$/.test(text)
  }

  /**
   * What goes before the next prompt. A command that printed text with no final newline (`cat` of a file
   * that does not end in one) left the cursor mid-line; erasing the line there deleted the output, so
   * start a new line instead, as zsh does. At the start of a line the line is simply cleared.
   */
  private promptLead(): string {
    return this._atLineStart ? ansi.erase.inLine(2) : '\r\n'
  }

  override write(data: string | Uint8Array) {
    this.noteOutput(data, false)
    for (const sink of this._mirrors) sink(data)
    super.write(data)
    this.events.dispatch<TerminalWriteEvent>(TerminalEvents.WRITE, { text: typeof data === 'string' ? data : new TextDecoder().decode(data) })
    if (this._isMobile) {
      setTimeout(() => this._scrollTerminalToBottom(), 0)
    }
  }

  override writeln(data: string | Uint8Array) {
    this.noteOutput(data, true)
    for (const sink of this._mirrors) { sink(data); sink('\r\n') }
    super.writeln(data)
    this.events.dispatch<TerminalWritelnEvent>(TerminalEvents.WRITELN, { text: typeof data === 'string' ? data : new TextDecoder().decode(data) })
    if (this._isMobile) {
      setTimeout(() => this._scrollTerminalToBottom(), 0)
    }
  }

  /**
   * Creates a new ReadableStream subscribed to keyboard input.
   * Each call returns an independent stream that receives all keyboard input.
   * The stream is automatically unsubscribed when cancelled or closed.
   */
  private createSubscribedInputStream(): { stream: ReadableStream<Uint8Array>, close: () => void } {
    let callback: ((data: Uint8Array) => void) | null = null
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    
    const stream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        controller = ctrl
        callback = (data: Uint8Array) => {
          try {
            controller!.enqueue(data)
          } catch {
            // Stream closed, unsubscribe
            if (callback) {
              this._stdinSubscribers.delete(callback)
              callback = null
            }
          }
        }
        this._stdinSubscribers.add(callback)
      },
      cancel: () => {
        if (callback) {
          this._stdinSubscribers.delete(callback)
          callback = null
        }
        controller = null
      }
    })

    const close = () => {
      if (controller) {
        try {
          controller.close()
        } catch {
          // Controller may already be closed
        }
        controller = null
      }
      if (callback) {
        this._stdinSubscribers.delete(callback)
        callback = null
      }
    }

    return { stream, close }
  }

  /**
   * Get a new input stream subscribed to keyboard input.
   * Each call returns an independent stream.
   */
  getInputStream(): ReadableStream<Uint8Array> {
    return this.createSubscribedInputStream().stream
  }

  /**
   * Get a new input stream with a close function to signal EOF.
   * Use this when you need to close the stream gracefully (e.g., for Ctrl+D).
   */
  getInputStreamWithClose(): { stream: ReadableStream<Uint8Array>, close: () => void } {
    return this.createSubscribedInputStream()
  }

  /**
   * Dispatch data to all stdin subscribers.
   * Used to send keyboard input to processes reading from stdin.
   */
  dispatchStdin(key: string) {
    if (key && key.length > 0) {
      const data = new TextEncoder().encode(key)
      for (const callback of this._stdinSubscribers) {
        try {
          callback(data)
        } catch {
          // Subscriber may be closed, will be cleaned up
        }
      }
    }
  }

  /** Erases the line being typed from the screen and returns it. `Kernel` uses this to make room for output. */
  clearCommand() {
    return this._editor.clear()
  }

  /** Puts a line back on the prompt, as `clearCommand` took it. */
  restoreCommand(cmd: string) {
    this._editor.set(cmd)
    this.write(this._linePrefix() + this._renderCommand(cmd))
  }

  private _detectMobileSupport() {
    this._isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      (typeof window !== 'undefined' && 'ontouchstart' in window) ||
      (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)

    this._visualViewportSupported = typeof window !== 'undefined' && 
      'visualViewport' in window &&
      window.visualViewport !== null
  }

  private _setupKeyboardHandling() {
    if (!this._isMobile) return

    if (this._visualViewportSupported) {
      try {
        const viewport = window.visualViewport!
        
        const handleViewportChange = () => {
          if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout)
          }
          this._resizeTimeout = setTimeout(() => {
            this._resizeTerminalToViewport()
          }, 50)
        }
        
        viewport.addEventListener('resize', handleViewportChange)
        
        const cleanup = () => {
          if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout)
            this._resizeTimeout = null
          }
          viewport.removeEventListener('resize', handleViewportChange)
        }
        this._viewportListeners.push(cleanup)
        
        this._lastViewportHeight = viewport.height
        this._resizeTerminalToViewport()
      } catch (error) {
        console.warn('Failed to setup Visual Viewport API:', error)
      }
    }
  }

  private _resizeTerminalToViewport() {
    if (!this._isMobile || this._isResizing) return
    
    const viewport = this._visualViewportSupported ? window.visualViewport : null
    if (!viewport) return
    
    const terminalContainer = document.getElementById('terminal')
    if (!terminalContainer) return
    
    const newHeight = viewport.height
    
    if (Math.abs(newHeight - this._lastViewportHeight) < 1) {
      return
    }
    
    this._isResizing = true
    this._lastViewportHeight = newHeight
    
    try {
      terminalContainer.style.height = `${newHeight}px`
      terminalContainer.style.maxHeight = `${newHeight}px`
      
      if (this.element) {
        this.element.style.height = `${newHeight}px`
      }
      
      if (this.addons?.get('fit')) {
        this.fitToContainer()
      }
      
      this._scrollTerminalToBottom()
    } finally {
      this._isResizing = false
    }
  }
  
  private _scrollTerminalToBottom() {
    if (!this.element) return
    
    const viewportElement = this.element.querySelector('.xterm-viewport') as HTMLElement
    if (viewportElement) {
      viewportElement.scrollTop = viewportElement.scrollHeight
    }
    
    this.scrollToBottom()
  }

  /**
   * `readline()` on a phone: a focused invisible text field does the editing and this draws its value. Shared by text
   * and password input, which differ in the input `type`, the echo, and `_passwordInputElement`.
   */
  private async _readlineWithDomInput(prompt: string, noListen: boolean, secret: boolean): Promise<string> {
    const wasListening = this._keyListener !== undefined
    this.unlisten()
    this.write(stripMarkers(prompt))

    const field = document.createElement('input')
    field.type = secret ? 'password' : 'text'
    field.style.position = 'fixed'
    field.style.top = '0'
    field.style.left = '0'
    field.style.width = '1px'
    field.style.height = '1px'
    field.style.opacity = '0'
    field.style.pointerEvents = 'auto'
    field.style.zIndex = '-1'
    field.setAttribute('inputmode', 'text')
    field.setAttribute('autocapitalize', 'off')
    field.setAttribute('autocorrect', 'off')
    field.setAttribute('spellcheck', 'false')
    field.setAttribute('enterkeyhint', 'send')

    document.body.appendChild(field)
    if (secret) this._passwordInputElement = field

    this._scrollTerminalToBottom()
    this._resizeTerminalToViewport()

    setTimeout(() => { field.focus() }, 100)

    const result = await new Promise<string>((resolve) => {
      let resolved = false
      let keyListener: IDisposable | null = null

      const cleanup = () => {
        if (resolved) return
        resolved = true
        field.removeEventListener('input', handleInput)
        field.removeEventListener('keydown', handleKeyDown)
        field.removeEventListener('blur', handleBlur)
        if (keyListener) {
          keyListener.dispose()
          keyListener = null
        }
        field.remove()
        if (secret) this._passwordInputElement = null
      }

      const handleInput = () => {
        const shown = secret ? '*'.repeat(field.value.length) : field.value
        this.write('\r' + ansi.cursor.horizontalAbsolute(visibleWidth(prompt) + 1) + ansi.erase.inLine(0) + shown)
      }

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.target !== field) {
          e.preventDefault()
          e.stopPropagation()
          return
        }

        if (e.key !== 'Enter' && e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        const value = e.key === 'Enter' ? field.value.trim() : ''
        cleanup()
        if (e.key === 'Enter') this.write('\n')
        setTimeout(() => resolve(value), e.key === 'Enter' ? 0 : undefined)
      }

      const handleBlur = () => {
        setTimeout(() => {
          if (field && document.body.contains(field) && !resolved) field.focus()
        }, 100)
      }

      field.addEventListener('input', handleInput)
      field.addEventListener('keydown', handleKeyDown)
      field.addEventListener('blur', handleBlur)

      keyListener = this.onKey(({ domEvent }) => {
        if (domEvent.target !== field) {
          domEvent.preventDefault()
          domEvent.stopPropagation()
        }
      })
    })

    if (wasListening && !noListen) this.listen()
    return result
  }

  /** Empties `uid`'s history, in memory and on disk (the `history -c` syscall). */
  async clearHistory(uid: number): Promise<void> {
    await this._history.clear(uid)
  }

  /** Re-reads `uid`'s history file, after something else (`history -r`) changed it. */
  async reloadHistory(uid: number): Promise<void> {
    await this._history.load(uid, true)
  }

  private async getCompletionMatches(partial: string): Promise<string[]> {
    const shell = this._shell
    return completionMatches(partial, {
      listDir: dir => shell.context.fs.promises.readdir(dir),
      isDirectory: async target => (await shell.context.fs.promises.stat(target)).isDirectory(),
      variable: name => shell.env.get(name),
      get cwd() { return shell.cwd },
      expandTilde: text => shell.expandTilde(text),
      builtins: trueBuiltinNames,
      programmable: line => programmableCompletion(kernelBuiltinHost(shell as unknown as KernelShell), line)
    })
  }
}


// --- Spinner ---
type Timer = ReturnType<typeof setInterval>

export class Spinner {
  terminal: Terminal
  interval: number
  frames: string[]
  loop?: Timer
  prefix?: string
  suffix?: string

  constructor(terminal: Terminal, interval: number, frames: string[], prefix?: string, suffix?: string) {
    this.terminal = terminal
    this.interval = interval
    this.frames = frames
    this.prefix = prefix
    this.suffix = suffix
  }

  once() {
    this.start()
    setTimeout(() => this.stop(), this.interval * this.frames.length)
  }

  start() {
    let index = 0
    this.terminal.write(ansi.cursor.hide)
    const interval = setInterval(() => {
      const currentFrame = this.frames[index];
      const fullText = `${this.prefix ? this.prefix + ' ' : ''}${currentFrame}${this.suffix ? ' ' + this.suffix : ''}`;

      this.terminal.write(fullText)
      index = (index + 1) % this.frames.length

      // Calculate the visual width of the full text
      const fullWidth = [...fullText].reduce((width, char) => {
        if (/\p{Emoji}/ug.test(char)) return width + 1; // Emoji generally takes 2 spaces
        if (/[\u3000\u3001-\u303F]|[\u3040-\u309F]|[\u30A0-\u30FF]|[\uFF00-\uFFEF]|[\u4E00-\u9FAF]|[\u2605-\u2606]|[\u2190-\u2195]|\u203B/ug.test(char)) return width + 2; // Wide characters
        return width + 1; // Regular character
      }, 0);

      this.terminal.write(`\x1b[${fullWidth}D`)
    }, this.interval) as Timer

    this.loop = interval
    return interval
  }

  stop() {
    clearInterval(this.loop)
    this.terminal.write(ansi.cursor.show)
  }
}