/**
 * Core kernel types and interfaces
 */

import type { Host } from './host.ts'
import type { BIOSModule } from '@ecmaos/bios'
import type { InitOptions } from 'i18next'
import type Module from 'node:module'
import type { JSONSchemaForNPMPackageJsonFiles } from '@schemastore/package'

import type {
  Auth,
  Components,
  Dom,
  DomOptions,
  KernelCharDevice,
  KernelDevice,
  EventCallback,
  Events,
  Filesystem,
  FilesystemConfigMounts,
  FilesystemOptions,
  I18n,
  Intervals,
  KernelModules,
  Keyboard,
  Log,
  LogOptions,
  Memory,
  Protocol,
  Service,
  ServiceOptions,
  Shell,
  Sockets,
  StorageProvider,
  Telemetry,
  Terminal,
  Users,
  Wasm,
  Windows,
  Workers,
} from './index.ts'

/**
 * The cross-cutting primitives every subsystem may depend on, with no
 * back-reference to the Kernel itself.
 *
 * A subsystem that needs another subsystem declares a narrow `deps` interface
 * alongside this (typically a `Pick<>` of the sibling it actually uses) rather
 * than growing this type. If a field feels like it belongs here, that is the
 * signal it is a real dependency and belongs in `deps` instead.
 */
export interface KernelContext {
  /** Unique identifier for this kernel instance */
  readonly id: string

  /** Logging system */
  readonly log: Log

  /** Event management system */
  readonly events: Events

  /** Internationalization service */
  readonly i18n: I18n
}

/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * @remarks
 * The Kernel class is the core of the ecmaOS system.
 * It manages the system's resources and provides a framework for system services.
 *
 */
export interface Kernel {
  /** Unique identifier for this kernel instance */
  readonly id: string

  /** Name of the kernel */
  readonly name: string

  /** Version string of the kernel */
  readonly version: string

  /** Current state of the kernel */
  readonly state: KernelState

  /** The environment this kernel runs in (browser or Node) */
  readonly host: Host

  /** Configuration options passed to the kernel */
  readonly options: KernelOptions

  /** Terminal interface for user interaction */
  readonly terminal: Terminal

  /** Shell for command interpretation and execution */
  readonly shell: Shell

  /** Logging system */
  readonly log: Log

  // Core services

  /** Authentication and authorization service */
  readonly auth: Auth

  /** BIOS module providing low-level functionality */
  bios?: BIOSModule

  /** Broadcast channel for inter-kernel communication */
  readonly channel: BroadcastChannel

  /** Web Components manager */
  readonly components: Components

  /** DOM manipulation service */
  readonly dom: Dom

  /** Map of registered devices and their drivers */
  readonly devices: Map<string, { device: KernelDevice, drivers?: KernelCharDevice[] }>

  /** Event management system */
  readonly events: Events

  /** Virtual filesystem */
  readonly filesystem: Filesystem

  /** Internationalization service */
  readonly i18n: I18n

  /** Interval management service */
  readonly intervals: Intervals

  /** Keyboard interface */
  readonly keyboard: Keyboard

  /** Memory management service */
  readonly memory: Memory

  /** Module management service */
  readonly modules: KernelModules

  /** Map of loaded packages */
  readonly packages: Map<string, Module>

  /** Protocol handler service */
  readonly protocol: Protocol

  /** Socket connection management service */
  readonly sockets: Sockets

  /** Map of available screensavers */
  readonly screensavers: Map<string, {
    default: (options: { terminal: Terminal }) => Promise<void>
    exit: () => Promise<void>
  }>

  /** Service management system */
  readonly service: Service

  /** Storage provider interface */
  readonly storage: StorageProvider

  /** Telemetry service for OpenTelemetry tracing */
  readonly telemetry: Telemetry

  /** User management service */
  readonly users: Users

  /** WebAssembly service */
  readonly wasm: Wasm

  /** Window management service */
  readonly windows: Windows

  /** Web Worker management service */
  readonly workers: Workers

  // Event handling aliases

  /** Add an event listener */
  addEventListener: (event: KernelEvents, listener: EventCallback) => void

  /** Remove an event listener */
  removeEventListener: (event: KernelEvents, listener: EventCallback) => void

  // Core methods

  /** Boot the kernel with optional configuration */
  boot(options?: BootOptions): Promise<void>

  /** Configure kernel options */
  configure(options: KernelOptions): Promise<void>

  /** Execute a command or program */
  execute(options: KernelExecuteOptions): Promise<number>

  /** Get the main export from a package */
  getPackageMainExport(pkgData: JSONSchemaForNPMPackageJsonFiles): string | null

  /** Show a system notification */
  notify(title: string, options?: object): Promise<Notification | void>

  /**
   * Start the idle-timeout screensaver daemon.
   * @returns a function that stops it and removes its listeners, or undefined if the configured
   * screensaver isn't registered
   */
  startScreensaverDaemon(): (() => void) | undefined

  /** Add an event listener */
  on(event: KernelEvents, listener: EventCallback): void

  /** Remove an event listener */
  off(event: KernelEvents, listener: EventCallback): void

  /** Reboot the kernel */
  reboot(): Promise<void>

  /** Shutdown the kernel */
  shutdown(): Promise<void>

  /** Switch to a different TTY */
  switchTty(ttyNumber: number): Promise<void>

  /** Get a shell by TTY number */
  getShell(ttyNumber: number): Shell | undefined

  /** Create a new shell and terminal for a TTY */
  createShell(ttyNumber: number): Promise<Shell>

  /** Currently active TTY number */
  readonly activeTty: number

  /** Map of all shells by TTY number */
  readonly shells: Map<number, Shell>
}

/**
 * Kernel events
 */
export enum KernelEvents {
  BOOT = 'kernel:boot',
  EXECUTE = 'kernel:execute',
  PANIC = 'kernel:panic',
  REBOOT = 'kernel:reboot',
  SHUTDOWN = 'kernel:shutdown',
  UPLOAD = 'kernel:upload'
}

/**
 * Kernel states
 */
export enum KernelState {
  BOOTING = 'booting',
  PANIC = 'panic',
  RUNNING = 'running',
  SHUTDOWN = 'shutdown'
}

/**
 * Options for configuring the kernel
 */
export interface KernelOptions {
  blacklist?: {
    commands?: string[]
  }
  credentials?: {
    username: string
    password: string
  }
  devices?: Record<string, KernelDevice>
  dom?: DomOptions
  filesystem?: FilesystemOptions<FilesystemConfigMounts>
  /** The environment the kernel runs in; the browser when omitted */
  host?: Host
  /** Where the initfs tarball is (default `/initfs.tar.gz`, or `ECMAOS_INITFS`); `false` installs none */
  initfs?: string | false
  i18n?: InitOptions & {
    fsTranslationsPath?: string
  }
  log?: LogOptions
  /**
   * Where the catalog of prebuilt WebAssembly programs is (default `/programs/index.json`); `false` installs none.
   * See `@ecmaos/coreutils` and `@ecmaos/coreutils-copyleft`, which supply the programs.
   */
  programs?: string | false
  /** context and filesystem are supplied by Kernel itself when constructing Service */
  service?: Omit<ServiceOptions, 'context' | 'filesystem'>
}

/**
 * Options for booting the kernel
 */
export interface BootOptions {
  figletFont?: string
  figletFontRandom?: boolean
  figletColor?: string
  silent?: boolean
}

/**
 * Options for executing commands
 */
export interface KernelExecuteOptions {
  command: string
  file?: string
  args?: string[]
  kernel?: Kernel
  shell: Shell
  terminal?: Terminal
  stdin?: ReadableStream<Uint8Array>
  stdinIsTTY?: boolean
  /** Called with the bytes of `stdin` the program never read, once it has exited; for a stdin the shell shares with later commands */
  stdinLeftover?: (bytes: Uint8Array) => void
  stdout?: WritableStream<Uint8Array>
  stdoutIsTTY?: boolean
  /**
   * Whether this stage's `stdout` must be fully drained before its exit code is reported.
   *
   * True for a final destination -- a file, or the terminal -- where `cmd > f` has to leave every
   * byte in `f` before the next statement reads it. False mid-pipeline, where the next stage's own
   * reads already order the data and waiting would deadlock: a downstream program that exits early
   * (`producer | head -1`) stops reading, the pipe fills, and the upstream drain would never finish.
   *
   * Before this existed the kernel slept a fixed 15ms instead, which is not long enough under load --
   * `cat <<EOF > f` followed by reading `f` failed intermittently in a loaded parallel test run and
   * passed every time in isolation.
   */
  drainStdout?: boolean
  stderr?: WritableStream<Uint8Array>
  /**
   * Called synchronously once a real `@zenfs/linux` `Process` has been constructed for this stage
   * (currently only `Kernel.executeViaExecve`'s `js`/`node` binfmt path), before the caller awaits
   * its completion. This is the only way `Shell`'s job table gets a signalable handle for `^C`/`^Z`/
   * `fg`/`bg` -- `ShellExecute` otherwise only returns the eventual exit code, too late to attach a
   * live handle to a `Job` while the stage is still running. A stage that never goes through a real
   * `Process` (any coreutil, which runs synchronously in the shell's own tick) never calls this.
   */
  onProcess?: (process: JobProcessHandle) => void
  /**
   * Whether this stage belongs to the shell's current foreground job (default `true`) -- a
   * backgrounded (`&`) pipeline passes `false` so its process never takes over the controlling
   * terminal. Only `Kernel.executeViaExecve`'s real-`Process` path acts on this: it sets the
   * attached TTY's `foreground` (`tty->pgrp`, answering `TIOCGPGRP`/`TIOCSPGRP`) to the new process
   * while it runs, and restores whatever it was beforehand once the process exits. A coreutil stage
   * has no real `Process` to own the terminal with, so this has no effect there.
   */
  foreground?: boolean
}

/**
 * The minimal slice of `@zenfs/linux`'s `Process` that job control needs: enough to signal it and
 * to know its status, without `core/types` depending on `@zenfs/linux`'s `Process` class directly
 * everywhere `KernelExecuteOptions` is used. `core/kernel` passes the real thing; it happens to
 * satisfy this shape already.
 */
export interface JobProcessHandle {
  readonly pid: number
  readonly stopped: boolean
  readonly exited: Promise<number>
  kill(signal: number | string): boolean
  /**
   * Give this process the controlling terminal (`tty->pgrp`, what `TIOCGPGRP`/`TIOCSPGRP` answer)
   * or take it back, without touching whichever process held it before -- `fg`/`bg` call this to
   * keep the TTY's notion of the foreground process in step with the shell's own job table once a
   * job moves between them after it has already started (as opposed to `KernelExecuteOptions.foreground`,
   * which only covers a stage's initial launch). A stage with no real `Process` behind it (any
   * coreutil pipeline) has no handle carrying this at all, so `fg`/`bg` call it optionally.
   */
  setForeground?: (isForeground: boolean) => void
}

/**
 * Event interfaces
 */
export interface KernelExecuteEvent {
  command: string
  args?: string[]
  exitCode: number
}

export interface KernelPanicEvent {
  error: Error
}

export interface KernelShutdownEvent {
  data: Record<string, unknown>
}

export interface KernelUploadEvent {
  file: string
  path: string
}
