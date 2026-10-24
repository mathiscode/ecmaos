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
  DetachedOptions,
  TerminalWindowHandle,
  TerminalWindowOptions,
  Workers,
} from './index.ts'

/**
 * The primitives every subsystem may depend on, with no back-reference to the Kernel. A subsystem that needs another
 * declares a narrow `deps` interface (typically a `Pick<>` of that sibling) instead of growing this type.
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

  /** Nodes made and removed at runtime, for devices that come and go */
  readonly devices: {
    /** Gives `driver` (a device of package `pkg`) its node; the function returned takes it away, and a file still open on it gets `ENODEV` */
    add(pkg: string, driver: KernelCharDevice): () => void
  }
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

  /** Opens a window with a terminal emulator running a program (a login shell by default) on a pty */
  openTerminalWindow(options: TerminalWindowOptions): Promise<TerminalWindowHandle>

  /** Runs a program as a user on a pty nothing watches, returning its exit code; for programs that open their own windows */
  runDetached(options: DetachedOptions): Promise<number>

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
  /**
   * Limits for the IndexedDB root, which is held whole in memory: the most one file may hold (`EFBIG` past it) and
   * the total in
   * memory that logs a warning. Both default from the device's memory (512 MiB and 1 GiB on an 8 GB machine or
   * better); `false`
   * turns one off.
   */
  limits?: { maxFileBytes?: number | false, warnResidentBytes?: number | false }
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
  /** The path as typed (`./script`), which a script reports in its messages and has as `$0`; `command` is the resolved one */
  invokedAs?: string
  file?: string
  args?: string[]
  kernel?: Kernel
  shell: Shell
  terminal?: Terminal
  stdin?: ReadableStream<Uint8Array>
  /**
   * A file or device to be the program's real standard input (`cmd < file`), as a descriptor the program can `fstat` and
   * seek, rather than a pipe fed from `stdin`. Only a program run as a process (`executeViaExecve`) takes it; for anything
   * else the stream comes from `openStdin`.
   */
  stdinFile?: string
  /** Makes the stream for `stdinFile`, for the paths that cannot use a descriptor */
  openStdin?: () => ReadableStream<Uint8Array>
  stdinIsTTY?: boolean
  /**
   * Called with the bytes of `stdin` the program never read, once it has exited; for a stdin the shell shares with
   * later commands
   */
  stdinLeftover?: (bytes: Uint8Array) => void
  stdout?: WritableStream<Uint8Array>
  stdoutIsTTY?: boolean
  /**
   * Whether this stage's `stdout` must be fully drained before its exit code is reported. True for a final
   * destination (a file or the terminal) so `cmd > f` leaves every byte in `f`; false mid-pipeline, where an early-
   * exiting downstream program would leave the drain waiting forever.
   */
  drainStdout?: boolean
  stderr?: WritableStream<Uint8Array>
  /**
   * Called synchronously once a `@zenfs/linux` `Process` exists for this stage (`Kernel.executeViaExecve`), before
   * completion is awaited, so the shell's job table can signal it for `^C`, `^Z`, `fg` and `bg`.
   */
  onProcess?: (process: JobProcessHandle) => void
  /**
   * Whether this stage belongs to the foreground job (default `true`). A backgrounded (`&`) stage passes `false` so
   * it does not take the terminal. `Kernel.executeViaExecve` sets the TTY's `foreground` to the process while it runs
   * and restores it afterwards.
   */
  foreground?: boolean
}

/** The slice of `@zenfs/linux`'s `Process` that job control needs: signalling it and reading its status. */
export interface JobProcessHandle {
  readonly pid: number
  readonly stopped: boolean
  readonly exited: Promise<number>
  kill(signal: number | string): boolean
  /**
   * Gives this process the controlling terminal (`tty->pgrp`) or takes it back, so `fg` and `bg` keep the TTY's
   * foreground in step with the job table after a job has started.
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
