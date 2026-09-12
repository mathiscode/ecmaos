/**
 * Terminal types and interfaces
 */

import type { ITerminalAddon, ITerminalOptions, Terminal as XTerm } from '@xterm/xterm'
import type { OptionDefinition } from 'command-line-args'
import type { TTY } from '@zenfs/linux'

import type { Dom } from './dom.ts'
import type { Kernel, KernelContext, KernelState } from './kernel.ts'
import type { Process } from './processes.ts'
import type { Shell } from './shell.ts'
import type { Users } from './users.ts'

/**
 * Terminal configuration options
 */
export interface TerminalOptions extends ITerminalOptions {
  /** XTerm addons to load */
  addons?: Map<string, ITerminalAddon>
  /** The cross-cutting kernel primitives (log, events, i18n) */
  context: KernelContext
  /** The DOM service, for the topbar and mobile controls */
  dom: Dom
  /**
   * Used for a couple of narrow, direct reads (e.g. `kernel.state` while booting) -- most of
   * `Terminal`'s own `Kernel` needs go through `context`/`dom`/`users`/`wire()` instead. No longer
   * used to construct a command set at all: command dispatch is real `execve`/`$PATH` resolution
   * plus a lazily-constructed legacy shim (see `@ecmaos/coreutils`'s `legacy-command-shim.ts`),
   * neither of which needs a `Kernel` reference cached on `Terminal` itself.
   */
  kernel: Kernel
  /** The user registry, for resolving the current user's display name/prompt */
  users: Users
  /** Reference to shell instance */
  shell?: Shell
  /** WebSocket connection */
  socket?: WebSocket
  /** Terminal theme */
  theme?: {
    background?: string
    foreground?: string
    promptColor?: string
  }
}

/**
 * What `Terminal` needs from `Kernel` itself that isn't a subsystem -- `switchTty` and `reboot`
 * are `Kernel` methods, and `getState` reads its boot-lifecycle state -- delivered via `wire()`
 * once the `Kernel` instance exists (it does from the first line of its own constructor, but
 * `Terminal` is constructed before `Kernel`'s constructor body finishes, so this is still lazy).
 */
export interface TerminalWiring {
  switchTty: (tty: number) => Promise<void>
  reboot: () => void
  getState: () => KernelState
}

/**
 * Terminal events
 */
export enum TerminalEvents {
  ATTACH = 'terminal:attach',
  CREATED = 'terminal:created',
  EXECUTE = 'terminal:execute',
  INPUT = 'terminal:input',
  INTERRUPT = 'terminal:interrupt',
  KEY = 'terminal:key',
  LISTEN = 'terminal:listen',
  MESSAGE = 'terminal:message',
  MOUNT = 'terminal:mount',
  PASTE = 'terminal:paste',
  RESIZE = 'terminal:resize',
  UNLISTEN = 'terminal:unlisten',
  WRITE = 'terminal:write',
  WRITELN = 'terminal:writeln'
}

/**
 * Terminal event interfaces
 */
export interface TerminalAttachEvent {
  terminal: Terminal
  socket: WebSocket
}

export interface TerminalCreatedEvent {
  terminal: Terminal
}

export interface TerminalExecuteEvent {
  terminal: Terminal
  command: string
}

export interface TerminalInputEvent {
  terminal: Terminal
  data: string
}

export interface TerminalInterruptEvent {
  terminal: Terminal
}

export interface TerminalKeyEvent {
  key: string
  domEvent: KeyboardEvent
}

export interface TerminalListenEvent {
  terminal: Terminal
}

export interface TerminalMessageEvent {
  terminal: Terminal
  message: MessageEvent
}

export interface TerminalMountEvent {
  terminal: Terminal
  element: HTMLElement
}

export interface TerminalPasteEvent {
  text: string
}

export interface TerminalResizeEvent {
  cols: number
  rows: number
}

export interface TerminalUnlistenEvent {
  terminal: Terminal
}

export interface TerminalWriteEvent {
  text: string
}

export interface TerminalWritelnEvent {
  text: string
}

/**
 * Interface for terminal functionality
 */
export interface Terminal extends XTerm {
  /** The `@zenfs/linux` TTY this terminal is attached to, once `mount()` has run */
  readonly zfsTty: TTY | undefined
  /** Get terminal addons */
  readonly addons: Map<string, ITerminalAddon>
  /** Get ANSI escape sequences */
  readonly ansi: {
    style: {
      reset: string
      bold: string
      green: string
      red: string
      yellow: string
      gray: string
      cyan: string
      [key: string]: string
    }
  }
  /** Get current command */
  readonly cmd: string
  /** Get current working directory */
  readonly cwd: string
  /** Get if terminal is running on mobile */
  readonly isMobile: boolean
  /** Get emoji utilities */
  readonly emojis: any
  /** Get event emitter */
  readonly events: any
  /** Get terminal ID */
  readonly id: string
  /** Get WebSocket connection */
  readonly socket?: WebSocket
  /** Get socket public key */
  readonly socketKey?: JsonWebKey
  /** Get standard input stream */
  readonly stdin: ReadableStream<Uint8Array>
  /** Get standard output stream */
  readonly stdout: WritableStream<Uint8Array>
  /** Get standard error stream */
  readonly stderr: WritableStream<Uint8Array>

  /** Get/set prompt template */
  promptTemplate: string

  /**
   * Mount terminal to DOM element
   * @param element - Element to mount to
   */
  mount(element: HTMLElement): void

  /**
   * Attach a shell to the terminal, updating shell reference and commands
   * @param shell - Shell to attach
   */
  attachShell(shell: Shell): void

  /** Hide terminal */
  hide(): void

  /** Show terminal */
  show(): void

  /**
   * Create a special terminal link
   * @param uri - Link URI
   * @param text - Link text
   */
  createSpecialLink(uri: string, text: string): string

  /**
   * Connect to WebSocket
   * @param socket - WebSocket to connect
   */
  connect(socket: WebSocket): void

  /** Start listening for input */
  listen(): void

  /** Stop listening for input */
  unlisten(): void

  /**
   * Read a line of input
   * @param prompt - Input prompt
   * @param hide - Hide input
   * @param noListen - Don't auto-listen
   */
  readline(prompt?: string, hide?: boolean, noListen?: boolean): Promise<string>

  /**
   * Create a spinner
   * @param spinner - Spinner type
   * @param prefix - Prefix text
   * @param suffix - Suffix text
   */
  spinner(spinner: string, prefix?: string, suffix?: string): any

  /**
   * Get terminal prompt
   * @param text - Prompt text
   */
  prompt(text?: string): string

  /**
   * Paste text to terminal
   * @param data - Text to paste
   */
  paste(data?: string): Promise<void>

  /**
   * Clear terminal command
   */
  clearCommand(): string

  /**
   * Restore terminal command
   * @param cmd - Command to restore
   */
  restoreCommand(cmd: string): void

  /**
   * Get input stream
   */
  getInputStream(): ReadableStream<Uint8Array>

  /**
   * Get a new input stream with a close function to signal EOF.
   * Use this when you need to close the stream gracefully (e.g., for Ctrl+D).
   */
  getInputStreamWithClose(): { stream: ReadableStream<Uint8Array>, close: () => void }

  /**
   * Dispatch data to all stdin subscribers.
   * Used to send keyboard input to processes reading from stdin.
   */
  dispatchStdin(key: string): void

  /**
   * Write text to terminal
   * @param data - Text to write
   */
  write(data: string | Uint8Array): void

  /**
   * Write line to terminal
   * @param data - Text to write
   */
  writeln(data: string | Uint8Array): void

  /**
   * Clear command history for a user
   * @param uid - User ID
   */
  clearHistory(uid: number): Promise<void>

  /**
   * Reload command history from file for a user
   * @param uid - User ID
   */
  reloadHistory(uid: number): Promise<void>

  /**
   * Update terminal configuration from shell config
   */
  updateConfig(): void

  /**
   * Supply the `Kernel`-level capabilities `Terminal` needs but that don't exist at construction
   * time; see {@link TerminalWiring}. Must be called before TTY switching (Ctrl+Shift+0-7) or
   * reboot (Ctrl+Alt+Delete) are used.
   */
  wire(wiring: TerminalWiring): void
}

export interface TerminalCommand {
  command: string
  description: string
  kernel: Kernel
  options?: OptionDefinition[]
  run: (pid: number, argv: string[]) => Promise<number | undefined | void>
  shell: Shell
  terminal: Terminal
  stdin?: ReadableStream<Uint8Array>
  stdout?: WritableStream<Uint8Array>
  stderr?: WritableStream<Uint8Array>

  /** Get formatted usage string including command description and options (only available when using unified parser) */
  readonly usage?: string
  /** Get formatted usage content string (only available when using unified parser) */
  readonly usageContent?: string
}

/**
 * Per-invocation context handed to a coreutils command alongside {@link CommandIO}, replacing the
 * old pattern of every command re-deriving `kernel.processes.get(pid)` and closing over `kernel`/
 * `shell`/`terminal` from the outer `createCommand` factory scope.
 */
export interface CommandContext {
  readonly kernel: Kernel
  readonly shell: Shell
  readonly terminal: Terminal
  /** The real process backing this invocation, when one exists (absent in some synchronous/test paths). */
  readonly process: Process | undefined
  readonly pid: number
  readonly argv: string[]
  readonly cwd: string
}

/**
 * Minimal per-invocation I/O handed to a coreutils command, replacing the old pattern of manually
 * resolving `process` and threading it plus `terminal` through `writelnStdout`/`writelnStderr` on
 * every call. `stdout`/`stderr`/`stdin` stay available as raw streams for commands that need
 * byte-level control (e.g. `cat`'s `getWriter()`/`getReader()` usage) -- this is deliberately a
 * thin wrapper, not a replacement for direct stream access.
 */
export interface CommandIO {
  /** Write raw text to stdout (the process's stdout if attached, else the terminal). */
  write(text: string): Promise<void>
  /** Write text followed by a newline to stdout. */
  writeln(text: string): Promise<void>
  /** Write raw text to stderr (the process's stderr if attached, else the terminal). */
  writeErr(text: string): Promise<void>
  /** Write text followed by a newline to stderr. */
  writelnErr(text: string): Promise<void>
  /** Raw stdout stream, when a real process is attached. */
  readonly stdout?: WritableStream<Uint8Array>
  /** Raw stderr stream, when a real process is attached. */
  readonly stderr?: WritableStream<Uint8Array>
  /** Raw stdin stream, when a real process is attached. */
  readonly stdin?: ReadableStream<Uint8Array>
  /** Whether stdout is attached to an interactive TTY vs a pipe/file. */
  readonly isTTY: boolean
}


