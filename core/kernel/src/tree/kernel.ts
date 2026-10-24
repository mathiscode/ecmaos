/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * The Kernel class is the core of the ecmaOS system.
 * It manages the system's resources and provides a framework for system services.
 *
 */

import { dynamicIoctl, dynamicMinor } from '#lib/dynamic-minors.ts'
import { startSession } from './lib/job-control.ts'
import { DEFAULT_UMASK, setUmask } from './lib/umask-store.ts'
import { installSkel, type SkelFs } from './lib/skel.ts'
import '#lib/process-shim.ts'
import ansi from 'ansi-escape-sequences'
import chalk from 'chalk'
import figlet from 'figlet'
import Module from 'node:module'
import path from 'node:path'
import semver from 'semver'

import { bindContext, boundContexts, Credentials, fs as zenfsFs } from '@zenfs/core'
import { char_dev, current as zenfsCurrent, Device, Module as ZenFSModule, Process as ZenFSProcess, processes as zenfsProcesses, Signal as ZenFSSignal, tty } from '@zenfs/linux'
import { BusType } from '@zenfs/linux/drivers/base/bus'
import { driver_init as initDriverCore } from '@zenfs/linux/drivers/base/init'
import { char_dev_init as initMemDevices } from '@zenfs/linux/drivers/char/mem'
import { of_platform_populate as populatePlatformBus } from '@zenfs/linux/drivers/of/device_tree'
import { kobj_init as initKobjects } from '@zenfs/linux/kobject'
import { pipefs } from '@zenfs/linux/fs/pipe'
import { createPipe } from '#lib/pipe-reaper.ts'
import { execveWhenFree as zenfsExecve } from '#lib/execve-retry.ts'
import { captureDom, installEvdevIoctl } from '#lib/evdev.ts'
import { installWarmThreads } from '#lib/warm-threads.ts'
import { registerGlControl } from '#lib/gl.ts'
import { Framebuffers } from '#lib/fb.ts'
import type { FileOperations } from '@zenfs/linux'
import { withErrno } from 'kerium'
import { JSONSchemaForNPMPackageJsonFiles } from '@schemastore/package'
import { context, trace } from '@opentelemetry/api'

import './../themes/default.scss'

import { Auth } from '#auth.ts'
import { Components } from '#components.ts'
import { DefaultDevices } from '#device.ts'
import { DefaultDomOptions, Dom } from '#dom.ts'
import { LogFile } from '#lib/log-file.ts'
import { registerHeldOperations } from '#lib/device-holds.ts'
import { DEFAULT_HOSTS, DEFAULT_SERVICES } from '#lib/hosts.ts'
import { claimMachine, stealMachineLock } from '#lib/machine-lock.ts'
import { DisplayOwner, type RemoteCall } from '#lib/remote-display.ts'
import { displayAddress } from '#lib/display-client.ts'
import { freshMachineName, machineKey, machineStore, parseMachine } from '#lib/machine.ts'
import type { MachineLock } from '#lib/machine-lock.ts'
import { showBadge, showOverlay } from '#lib/machine-overlay.ts'
import { configureQuotas, parseQuotas } from '#lib/quota.ts'
import { configureStorageLimits, formatBytes } from '#lib/storage-limits.ts'
import { SessionLog } from '#lib/sessions.ts'
import { sharesDestination } from '#lib/stream-twins.ts'
import { CommandLinks, SupersededPrograms, ensureSetuidPrograms, tightenDirectoryModes } from '#lib/fs-modes.ts'
import { canRunProgramsAsUser, credentialsFor, setuidCredentials } from '#lib/process-credentials.ts'
import { DefaultFilesystemOptions, DevLinks, Filesystem, fenceRootStore, rootStoreName, measureOwnedBytes, rootWritesSettled, withMemoryRoot, withRootStore } from '#filesystem.ts'
import { browserHost } from '#host.ts'
import { DefaultLogOptions, Log } from '#log.ts'
import { Terminal } from '#terminal.ts'
import { Events } from '#events.ts'
import { I18n } from '#i18n.ts'
import { Intervals } from '#intervals.ts'
import { Memory } from '#memory.ts'
import { Protocol } from '#protocol.ts'
import { DefaultServiceOptions, Service } from '#service.ts'
import { Sockets } from '#sockets.ts'
import { Shell } from '#shell.ts'
import { PopupRenderer } from '#popups.ts'
import { Storage } from '#storage.ts'
import { FitAddon } from '@xterm/addon-fit'
import { Telemetry } from '#telemetry.ts'
import { SHADOW_GID, SHADOW_GROUP, Users } from '#users.ts'
import { Wasm } from '#wasm.ts'
import { WindowServer } from '#windowserver.ts'
import { WinBoxRenderer } from '#windows.ts'
import { Workers } from '#workers.ts'

import { getLegacyCommands, resolveLegacyCommand } from '@ecmaos/coreutils'
import { DEFAULT_SUDOERS } from '@ecmaos/coreutils/lib/sudoers'
import { DEFAULT_INITTAB, gettyEntries, gettyTerminals, isUntouchedInittab, withGettyEntries, withoutGettyEntries } from '@ecmaos/coreutils/lib/inittab'
import { Init, INIT_BOOT_TIMEOUT_MS } from '#lib/init.ts'
import { DEFAULT_BOOT_INIT, removeStaleCommandStubs, runFsMigrations } from '#lib/fs-migrations.ts'
import { parseFstabFile } from '#lib/fstab.ts'
import { getCachedManifest, installSyscallPolicy } from '#lib/syscall-policy.ts'
import { isolationProblem } from '#lib/isolation.ts'
import { installSyscallTrace } from '#lib/syscall-trace.ts'
import { installMainThreadSyscalls, registerProcessKernel } from '#lib/main-thread-syscalls.ts'
import type { KernelPty } from '#lib/pty.ts'
import { openTerminalWindow, runDetached } from '#lib/terminal-window.ts'
import type { TerminalWindow } from '#lib/terminal-window.ts'
import migratedCommandSources from 'virtual:bin-commands'
import migratedKernelCommandSources from 'virtual:bin-kernel-commands'
import { installPrograms, PROGRAM_WAITER, programWaiterSource, stagePrograms } from '#lib/programs.ts'
import { DEFAULT_VIMRC } from '#lib/vimrc.ts'

import {
  KernelEvents,
  KernelState,
  TerminalEvents
} from '@ecmaos/types'

import type {
  BootOptions,
  Host,
  Kernel as IKernel,
  KernelContext,
  KernelCharDevice,
  KernelDevice,
  KernelExecuteEvent,
  KernelExecuteOptions,
  KernelOptions,
  KernelPanicEvent,
  Shell as IShell,
  Terminal as ITerminal,
  User,
  Wasm as IWasm,
  Windows as IWindows,
  DetachedOptions,
  TerminalWindowOptions,
  Workers as IWorkers,
  EventCallback,
  FileHeader,
  KernelShutdownEvent,
  KernelModule,
  KernelModules,
  CommandInvocation,
  Timer
} from '@ecmaos/types'

/**
 * Reads a structured (array/object) build constant that `vite.config.ts` `define`s under
 * `import.meta.env`. A bundled build inlines the real value; Vite 8's unbundled dev/test path
 * serves `import.meta.env` values as strings, so accept the JSON source text there too.
 */
function jsonEnv<T>(value: unknown): T | undefined {
  if (typeof value !== 'string') return value as T | undefined
  try { return JSON.parse(value) as T } catch { return undefined }
}

/** Reads a CSS custom property from the page root; empty when there is no DOM (a non-browser host). */
function cssVariable(name: string): string {
  if (!globalThis.document?.documentElement || typeof globalThis.getComputedStyle !== 'function') return ''
  return getComputedStyle(globalThis.document.documentElement).getPropertyValue(name).trim()
}

const DefaultKernelOptions: KernelOptions = {
  devices: DefaultDevices,
  dom: DefaultDomOptions,
  log: DefaultLogOptions,
  filesystem: DefaultFilesystemOptions,
  service: DefaultServiceOptions
}

const DefaultBootOptions: BootOptions = { silent: false }

/** Commands that live in `/sbin` rather than `/bin`. */
const SbinCommands = new Set(['init', 'getty'])
const DefaultFigletFonts = [
  '3-D',
  '3x5',
  '3D-ASCII',
  '5 Line Oblique',
  'Acrobatic',
  'Big',
  'Big Money-ne',
  'Broadway',
  'Bubble',
  'Caligraphy',
  'Caligraphy2',
  'Coinstak',
  'Computer',
  'Cosmike',
  'Cyberlarge',
  'Diamond',
  'Doom',
  'Keyboard',
  'Larry 3D',
  'OS2',
  'Poison',
  'Rounded',
  'Runyc',
  'S Blood'
]

/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * The Kernel class is the core of the ecmaOS system.
 * It manages the system's resources and provides a framework for system services.
 *
 * @returns {Kernel} The unbooted kernel instance.
 *
 * @example
 * ```javascript
 * const kernel = new Kernel()
 * await kernel.boot()
 * ```
 */
/** A login on a terminal with no page, from `Kernel.openSession` */
export interface KernelSession {
  tty: number
  shell: Shell
  terminal: Terminal
  /** Ends the session: hangs up whatever is running, records the logout and frees the TTY. Safe to call again. */
  close(): Promise<void>
}

export class Kernel implements IKernel {
  /** Unique identifier for this kernel instance */
  public readonly id: string = crypto.randomUUID()
  /** Name of the kernel */
  public readonly name: string = import.meta.env['NAME'] || 'ecmaOS'
  /** Version string of the kernel */
  public readonly version: string = import.meta.env['VERSION'] || '?.?.?'

  /** Authentication and authorization service */
  public readonly auth: Auth
  /** Broadcast channel for inter-kernel communication */
  public readonly channel: BroadcastChannel
  /** The machine this kernel runs (`?machine=NAME`); `undefined` is the default one. See `lib/machine.ts`. */
  public readonly machine: string | undefined
  private _machineError: string | undefined
  private _machineLock?: MachineLock
  /** Other tabs showing this machine's ttys (see `lib/remote-display.ts`) */
  private _displays?: DisplayOwner
  /** `/var/log/kernel.log`, written by the log's transport */
  private _logFile?: LogFile
  private _guestId?: string
  /** Web Components manager */
  public readonly components: Components
  /** DOM manipulation service */
  public readonly dom: Dom
  /** Map of registered devices and their drivers */
  public readonly devices: Map<string, { device: KernelDevice, drivers?: KernelCharDevice[] }> = new Map()
  /**
   * A kernel-lifetime `Process` that is never `execve`'d and holds the pipes made by `bridgeStdio`. It must be a
   * registered `Process`: `fs/pipe.ts` raises `EPIPE` unless some registered process references the other end.
   * Created lazily.
   */
  /** pid 1: `/sbin/init`, which runs `/etc/inittab`, supervises its daemons and reaps orphans. */
  readonly init = new Init()

  private _programsRunAsUser = false
  /**
   * Whether a user's programs run with that user's credentials, rather than all as root (see `canRunProgramsAsUser`)
   */
  get programsRunAsUser(): boolean { return this._programsRunAsUser }

  /**
   * The context a program started from `shell` runs in: the shell's own user, or `undefined` (root) for a root shell
   * or when the installed `@zenfs/core` cannot run programs as another user (see `canRunProgramsAsUser`).
   */
  processContext(shell: IShell, cwd: string, program?: string) {
    const { credentials } = shell
    // the mask goes to the file system only where it keeps one; the programs apply the shell's own (`umask-store.ts`)
    const umask = typeof (shell.context as { umask?: number }).umask === 'number' ? (shell as { umask?: number }).umask ?? 0 : 0
    // a program with the setuid bit runs with its owner's privileges, not the shell's
    const elevated = this._programsRunAsUser && program ? setuidCredentials(shell.context.fs, program.startsWith('/') ? program : `${cwd}/${program}`, credentials) : undefined
    const asUser = this._programsRunAsUser && (credentials.euid !== 0 || elevated !== undefined)
    // nothing to say that the default (root, no mask) context does not already
    if (!asUser && umask === 0) return undefined
    const init: Parameters<typeof bindContext>[0] & { umask?: number } = { root: '/', pwd: cwd, umask }
    if (asUser) init.credentials = credentialsFor(elevated ?? credentials)
    return bindContext(init)
  }

  private _pipeProcess?: InstanceType<typeof ZenFSProcess>
  /** The kernel's own process, whose table holds the pipe ends no program does: bridges, and sockets' connections */
  get pipeProcess(): InstanceType<typeof ZenFSProcess> {
    if (!this._pipeProcess) {
      this._pipeProcess = new ZenFSProcess({ console: '/dev/null' })
      this.init.adopt(this._pipeProcess)
    }
    return this._pipeProcess
  }

  /** Event management system */
  public readonly events: Events
  /** The environment this kernel runs in (browser or Node) */
  public readonly host: Host
  /** Virtual filesystem */
  public readonly filesystem: Filesystem
  /** Internationalization service */
  public readonly i18n: I18n
  /** Interval management service */
  public readonly intervals: Intervals
  /** Keyboard interface */
  public readonly keyboard: Keyboard
  /** Logging system */
  public readonly log: Log
  /** Memory management service */
  public readonly memory: Memory
  /** Map of loaded modules */
  public readonly modules: KernelModules = new Map()
  /** Configuration options passed to the kernel */
  public readonly options: KernelOptions
  /** Map of loaded packages */
  public readonly packages: Map<string, Module> = new Map()
  /** Protocol handler service */
  public readonly protocol: Protocol
  /** Socket connection management service */
  public readonly sockets: Sockets
  /** Map of available screensavers */
  public readonly screensavers: Map<string, { default: (options: { terminal: ITerminal }) => Promise<void>, exit: () => Promise<void> }>
  /** Service management system */
  public readonly service: Service
  /** Shell for command interpretation and execution */
  public readonly shell: Shell
  /**
   * The kernel's own shell, root's whoever is logged in: what runs init scripts, fstab mounts and cron jobs.
   * No user's session is ever lent to the kernel for these. It shows on the console (TTY 0) but is not its shell.
   */
  public readonly system: Shell
  /** Storage provider interface */
  public readonly storage: Storage
  /** Telemetry service for OpenTelemetry tracing */
  public readonly telemetry: Telemetry
  /** Terminal interface for user interaction */
  public readonly terminal: ITerminal
  /** User management service */
  public readonly users: Users
  /** WebAssembly service */
  public readonly wasm: IWasm
  /** Window management service */
  public readonly windows: IWindows
  /** The framebuffers (`/dev/fb<N>`), each drawing in a window */
  public readonly framebuffers: Framebuffers
  /** Web Worker management service */
  public readonly workers: IWorkers

  /** Current state of the kernel */
  private _state: KernelState = KernelState.BOOTING
  get state() { return this._state }

  /** Map of all shells by TTY number */
  private _shells: Map<number, Shell> = new Map()
  /** Currently active TTY number */
  private _activeTty: number = 0
  get activeTty() { return this._activeTty }
  get shells() { return this._shells }

  /** Add an event listener; alias for `events.on` */
  get addEventListener() { return this.events.on }
  /** Remove an event listener; alias for `events.off` */
  get removeEventListener() { return this.events.off }

  /** The cross-cutting primitives a subsystem or driver may depend on, with no back-reference to the Kernel itself */
  get context(): KernelContext {
    return { id: this.id, log: this.log, events: this.events, i18n: this.i18n }
  }

  constructor(_options: KernelOptions = DefaultKernelOptions) {
    this.host = _options.host ?? browserHost()
    this.options = { ...DefaultKernelOptions, ...this.host.defaults, ..._options }
    ;({ machine: this.machine, error: this._machineError } = parseMachine(this.host.machine))

    // Tier 0: no dependencies at all. This also establishes `this.context` (id/log/events/i18n),
    // the cross-cutting primitives every later subsystem takes instead of a back-reference to the
    // whole Kernel.
    this.auth = new Auth()
    this.channel = new BroadcastChannel(import.meta.env['NAME'] || 'ecmaos')
    this.components = new Components()
    this.devices = new Map<string, { device: KernelDevice, drivers?: KernelCharDevice[] }>()
    this.events = new Events()
    this.i18n = new I18n(this.options.i18n)
    this.intervals = new Intervals()
    this.keyboard = navigator.keyboard
    this.log = this.options.log ? new Log(this.options.log) : new Log()
    this.memory = new Memory()
    this.modules = new Map()
    this.screensavers = new Map()
    this.windows = new WindowServer()
    this.framebuffers = new Framebuffers(this.windows)
    this.workers = new Workers()

    // Tier 1: context-only.
    this.dom = new Dom(this.options.dom)
    this.sockets = new Sockets({ context: this.context })
    this.storage = new Storage({ context: this.context, host: this.host })
    this.telemetry = new Telemetry({ context: this.context })

    // Tier 2: context plus narrow, already-constructed dependencies (no cycles).
    this.filesystem = new Filesystem(this.storage, { initfs: this.options.initfs, fetch: this.host.fetch, key: key => this.machineKey(key) })
    this.users = new Users({
      context: this.context,
      filesystem: this.filesystem,
      getShellCredentials: () => this.shell.credentials
    })

    // Tier 3: the Shell/Terminal cycle. `Shell` tolerates a not-yet-real `terminal` (as it always
    // has - `attach()` below fixes it up), and `execute` is Kernel's own method, bound so Shell
    // never needs a `Kernel` reference of its own.
    this.shell = new Shell({
      context: this.context,
      createPipeStream: () => this.createPipeStream(),
      execute: options => this.execute({ ...options, kernel: this }),
      adoptProcess: process => this.init.adopt(process as InstanceType<typeof ZenFSProcess>),
      filesystem: this.filesystem,
      users: this.users,
      tty: 0,
      // KERNEL_NAME/KERNEL_VERSION/HOSTNAME: build-time constants a real execve'd worker process
      // has no other way to see (no `kernel` reference, no `window`) - threaded through env the same
      // way HOME/PATH/etc already are, for uname.mjs/hostname.mjs to read via `env` in ecmaosSyscalls.
      env: { KERNEL_NAME: this.name, KERNEL_VERSION: this.version, HOSTNAME: 'localhost' }
    })

    this.terminal = new Terminal({
      context: this.context,
      dom: this.dom,
      kernel: this, // only for TerminalCommands - see TerminalOptions.kernel's doc comment
      shell: this.shell,
      users: this.users,
      tty: 0
    })

    this.shell.attach(this.terminal)
    this._shells.set(0, this.shell)

    // Its output reaches the console through streams of its own: the terminal's are held by TTY 0's shell
    const console0 = this.terminal
    const forward = (wrap: (text: string) => string) => new WritableStream<Uint8Array>({ write: chunk => console0.write(wrap(new TextDecoder().decode(chunk))) })
    const consoleView = new Proxy(console0, {
      get: (target, key) => {
        if (key === 'stdout') return forward(text => text)
        if (key === 'stderr') return forward(text => `\x1b[31m${text}\x1b[39m`)
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    this.system = new Shell({
      context: this.context,
      createPipeStream: () => this.createPipeStream(),
      execute: options => this.execute({ ...options, kernel: this }),
      adoptProcess: process => this.init.adopt(process as InstanceType<typeof ZenFSProcess>),
      filesystem: this.filesystem,
      users: this.users,
      tty: 0,
      terminal: consoleView,
      env: { KERNEL_NAME: this.name, KERNEL_VERSION: this.version, HOSTNAME: 'localhost', HOME: '/root', USER: 'root', LOGNAME: 'root' }
    })
    // TTY 0 is the console that boots active, so its shell is the one `globalThis.process.env`
    // mirrors until `switchTty` hands ownership to another - see `Shell.claimProcessEnv`.
    this.shell.claimProcessEnv()

    // Tier 4: subsystems whose real dependencies (terminal, shell) only exist now. Constructed
    // with context alone, then wired.
    this.protocol = new Protocol({})
    this.protocol.wire({ terminal: this.terminal })

    this.service = new Service({ context: this.context, filesystem: this.filesystem, ...this.options.service })
    this.service.wire({ shell: this.shell, terminal: this.terminal })

    this.terminal.wire({
      switchTty: (tty: number) => this.switchTty(tty),
      reboot: () => this.requestReboot(),
      getState: () => this.state
    })

    // Still Kernel-shaped: Wasm's WASI Preview 1 bindings take a full Kernel throughout, and
    // narrowing that is the `wasm` branch's job (deleting most of preview1.ts), not this one's.
    this.wasm = new Wasm({ kernel: this })
  }

  /**
   * Boots the kernel and initializes all core services.
   * @param options - Boot configuration options
   * @throws {Error} If boot process fails
   */
  async boot(options: BootOptions = DefaultBootOptions) {
    const windowRenderer = new WinBoxRenderer()
    await Promise.all([this.telemetry.init(), this.dom.init(), windowRenderer.init()])
    this.windows.registerRenderer(windowRenderer)
    // the keyboard goes back to the terminal when the last window closes; the page has nothing focused then
    if (globalThis.document) this.windows.on('close', () => setTimeout(() => { if (this.windows.list().length === 0) (this._shells.get(this._activeTty)?.terminal ?? this.terminal).focus() }, 0))
    // an opt-in seamless mode: with `ecmaos:windows:popups` set to `1` in local storage, new windows are browser popups
    if (globalThis.document) this.windows.registerRenderer(new PopupRenderer(windowRenderer, { enabled: () => this.host.storage.local.getItem('ecmaos:windows:popups') === '1' }))
    // A host that shows windows itself (Node) is registered after the page's renderer, so it wins for the kinds it supports
    if (this.host.display) this.windows.registerRenderer(this.host.display.renderer)
    const tracer = this.telemetry.getTracer('ecmaos.kernel', this.version)
    const bootSpan = tracer.startSpan('kernel.boot', {
      attributes: {
        'kernel.id': this.id,
        'kernel.name': this.name,
        'kernel.version': this.version,
        'boot.silent': options.silent || false
      }
    })

    let spinner
    // Translation function will be set after locale is loaded
    let t: ReturnType<typeof this.i18n.i18next.getFixedT>

    try {
      this.dom.topbar()
      this.terminal.unlisten()

      const isolation = isolationProblem()
      if (isolation) throw new Error(isolation)

      // Setup kernel logging
      this.log.attachTransport((logObj) => {
        if (!logObj?.['_meta']) return
        const acceptedLevels = ['WARN', 'ERROR']
        if (!acceptedLevels.includes(logObj['_meta'].logLevelName)) return

        let color = chalk.gray
        switch (logObj['_meta'].logLevelName) {
          case 'DEBUG': color = chalk.green; break
          case 'INFO': color = chalk.blue; break
          case 'WARN': color = chalk.yellow; break
          case 'ERROR': color = chalk.red; break
        }

        const numericKeys = Object.keys(logObj).filter(key => !isNaN(Number(key)))
        const logMessage = `${logObj['_meta'].name} ${color(logObj['_meta'].logLevelName)}\t${numericKeys.map(key => logObj[key]).join(' ') || logObj.message}`
        this.terminal.writeln(logMessage)
      })

      // Configure filesystem first (needed before we can read locale file)
      const configureSpan = tracer.startSpan('kernel.boot.configure', {}, trace.setSpan(context.active(), bootSpan))
      if (this._machineError) this.log.warn(`${this._machineError}; running the default machine`)
      configureStorageLimits(this.options.limits, (resident, threshold) => this.log.warn(`The root filesystem holds ${formatBytes(resident)} in memory (warning at ${formatBytes(threshold)}); large files cost their size in RAM, so a small device may struggle. See the README's known gaps.`))
      const filesystemOptions = this.machineOptions(Filesystem.options(this.options.filesystem))
      // Before the root is loaded into memory: a second tab on the same store must not get that far
      const guest = await this.claimMachine(rootStoreName(filesystemOptions))
      await this.configure({ devices: this.options.devices || DefaultDevices, filesystem: guest ? withMemoryRoot(filesystemOptions) : filesystemOptions })
      if (guest) {
        this.log.warn('Guest session: this tab runs a scratch machine and nothing in it is saved')
        showBadge('Guest session: nothing is saved')
      }
      configureSpan.end()

      // Register ecmaOS's own custom syscalls (main-thread-only capabilities like DOM window
      // creation) before wrapping the table, so they get manifest-allowlist coverage too.
      installMainThreadSyscalls()

      // Wrap every registered syscall with a manifest-declared allowlist check, before any
      // program can execve and start calling them. A program with no manifest is unrestricted.
      installSyscallPolicy(this.filesystem.fs)
      // outside the policy wrapper, so a call a manifest refuses is in the trace too
      installSyscallTrace()

      // Create required filesystem paths (including /etc/default for locale file)
      const filesystemSpan = tracer.startSpan('kernel.boot.filesystem', {}, trace.setSpan(context.active(), bootSpan))
      const requiredPaths = [
        // /proc and /sys are their own mounted filesystems (ProcFS/SysFS); they are not created here
        '/bin', '/sbin', '/boot', '/tmp', '/home', '/lib', '/run', '/root', '/opt',
        '/etc', '/etc/default', '/etc/opt',
        '/var', '/var/cache', '/var/lib', '/var/log', '/var/spool', '/var/tmp', '/var/lock', '/var/opt', '/var/games',
        '/usr', '/usr/bin', '/usr/lib', '/usr/sbin', '/usr/share', '/usr/share/docs', '/usr/share/licenses', '/usr/include', '/usr/local'
      ]

      const specialPermissions: Record<string, number> = {
        '/root': 0o700
      }

      for (const path of requiredPaths) {
        let mode = 0o755
        if (specialPermissions[path]) mode = specialPermissions[path]
        if (!(await this.filesystem.fs.exists(path))) await this.filesystem.fs.mkdir(path, { recursive: true, mode })
      }
      filesystemSpan.setAttribute('filesystem.paths_created', requiredPaths.length)

      this._programsRunAsUser = await canRunProgramsAsUser(this.filesystem.fs)
      if (!this._programsRunAsUser) this.log.info('programs run as root: the installed @zenfs/core cannot open a file the caller does not own')

      // `/dev` is an in-memory devtmpfs rebuilt on every boot, so these are laid down every boot too.
      // Each is the symlink Linux ships, into the per-process descriptor table procfs serves.
      for (const [link, target] of Object.entries(DevLinks)) {
        if (!(await this.filesystem.fs.exists(link))) await this.filesystem.fs.symlink(target, link).catch(() => {})
      }

      // A persisted root may have been laid down by an older release; bring it up to this one's
      // schema before anything below reads or rewrites what it holds.
      const migrated = await runFsMigrations({
        fs: this.filesystem.fs,
        log: this.log,
        legacyCommandNames: new Set(Object.keys(getLegacyCommands()))
      })
      if (migrated.length) filesystemSpan.setAttribute('filesystem.migrations_applied', migrated.join(','))

      const tightened = await tightenDirectoryModes(this.filesystem.fs).catch(error => { this.log.warn(`directory modes: ${(error as Error).message}`); return [] as string[] })
      if (tightened.length) this.log.info(`Set the mode of ${tightened.length} system director${tightened.length === 1 ? 'y' : 'ies'}`)
      filesystemSpan.end()

      // `/run/utmp` starts empty each boot and `wtmp` gets a boot line; consoles fill them in as they log in.
      await new SessionLog(this.filesystem.fs).boot().catch(error => this.log.warn(`sessions: ${(error as Error).message}`))

      // Always rewritten, so a persisted filesystem picks up a new version. Mode 0o444.
      {
        // `this.name` is the package name in a build (`@ecmaos/kernel`), which is neither a name to show
        // nor a valid `ID` (lowercase letters, digits, `.`, `_` and `-`), so the file names the system itself.
        const osRelease = [
          'NAME="ecmaOS"',
          `VERSION="${this.version}"`,
          'ID=ecmaos',
          `VERSION_ID="${this.version}"`,
          `PRETTY_NAME="ecmaOS ${this.version}"`,
          import.meta.env['HOMEPAGE'] ? `HOME_URL="${import.meta.env['HOMEPAGE']}"` : ''
        ].filter(Boolean).join('\n') + '\n'

        await this.filesystem.fs.writeFile('/etc/os-release', osRelease, { mode: 0o444 })
      }

      if (!(await this.filesystem.fs.exists('/etc/hosts'))) {
        await this.filesystem.fs.writeFile('/etc/hosts', DEFAULT_HOSTS, { mode: 0o644 })
      }

      if (!(await this.filesystem.fs.exists('/etc/services'))) {
        await this.filesystem.fs.writeFile('/etc/services', DEFAULT_SERVICES, { mode: 0o644 })
      }

      if (!(await this.filesystem.fs.exists('/etc/hostname'))) {
        await this.filesystem.fs.writeFile('/etc/hostname', `${this.host.platform.hostname() || 'ecmaos'}\n`, { mode: 0o644 })
      }

      // Vim reads this before anything else (its build points the system vimrc here). Without one it
      // starts in vi-compatible mode, which is not what anyone running Vim expects.
      if (!(await this.filesystem.fs.exists('/etc/vimrc'))) {
        await this.filesystem.fs.writeFile('/etc/vimrc', DEFAULT_VIMRC, { mode: 0o644 })
      }

      // The files `useradd -m` gives a new home directory
      await installSkel(this.filesystem.fs as unknown as SkelFs)

      // The login shells `chsh` accepts. `ecmaos` is the shell built into the kernel and has no file;
      // `/bin/ecmash` is the same language as a program.
      if (!(await this.filesystem.fs.exists('/etc/shells'))) {
        await this.filesystem.fs.writeFile('/etc/shells', '# Valid login shells; see chsh(1).\n/bin/ecmash\necmaos\n', { mode: 0o644 })
      }

      // What every login shell reads first. The file creation mask is policy, not mechanism: a context starts with
      // none, and this is where a system says what it wants (022, as Linux distributions do).
      if (!(await this.filesystem.fs.exists('/etc/profile'))) {
        await this.filesystem.fs.writeFile('/etc/profile', '# /etc/profile: read by every login shell\n\n# new files are not writable by group or others (the shell applies it to what it and its programs create)\numask 022 2> /dev/null\n', { mode: 0o644 })
      }

      // Who may use `sudo`. Only root can read it, as on Linux, and a missing file means nobody may.
      if (!(await this.filesystem.fs.exists('/etc/sudoers'))) {
        await this.filesystem.fs.writeFile('/etc/sudoers', DEFAULT_SUDOERS, { mode: 0o440 })
      }

      // What init runs. A missing file is not fatal. With `options.credentials` the kernel logs in itself and no
      // getty entries are kept; an untouched default file from an earlier build is upgraded to match, an edited one
      // is left alone.
      const terminalCount = Math.min(8, Math.max(1, this.host.terminals ?? 8))
      const loginInittab = DEFAULT_INITTAB + gettyEntries(terminalCount)
      if (!(await this.filesystem.fs.exists('/etc/inittab'))) {
        await this.filesystem.fs.writeFile('/etc/inittab', this.options.credentials ? DEFAULT_INITTAB : loginInittab, { mode: 0o644 })
      } else {
        // Untouched means only the entries the kernel writes (whatever the comment header said in the
        // build that wrote it); anything else in the file is the user's and is left alone.
        const text = await this.filesystem.fs.readFile('/etc/inittab', 'utf-8')
        if (isUntouchedInittab(text)) {
          const gettys = gettyTerminals(text)
          if (this.options.credentials && gettys.size > 0) {
            await this.filesystem.fs.writeFile('/etc/inittab', withoutGettyEntries(text), { mode: 0o644 })
          } else if (!this.options.credentials && (gettys.size === 0 || (gettys.size === 1 && gettys.has(0)))) {
            // no getty yet, or the one-terminal default of an earlier build; fewer than eight otherwise is a choice
            await this.filesystem.fs.writeFile('/etc/inittab', withGettyEntries(text, terminalCount), { mode: 0o644 })
          }
        }
      }

      try {
        await this.shell.config.loadSystemConfig()
        this.terminal.updateConfig()
      } catch (error) {
        this.log.warn(`Failed to load system shell config: ${(error as Error).message}`)
      }

      const i18nResourcesSpan = tracer.startSpan('kernel.boot.i18n_resources', {}, trace.setSpan(context.active(), bootSpan))
      try {
        const i18nResult = await this.i18n.loadFilesystemResources(
          this.filesystem.fs,
          this.options.i18n?.fsTranslationsPath
        )
        i18nResourcesSpan.setAttribute('i18n.resources.bundles', i18nResult.bundles)
        i18nResourcesSpan.setAttribute('i18n.resources.files', i18nResult.files)
        if (i18nResult.errors.length > 0) {
          this.log.warn(`Loaded i18n resources with ${i18nResult.errors.length} error(s)`)
          for (const error of i18nResult.errors) this.log.warn(error)
        }
      } catch (error) {
        this.log.warn(`Failed to load filesystem i18n resources: ${(error as Error).message}`)
        i18nResourcesSpan.recordException(error as Error)
      }
      i18nResourcesSpan.end()

      // Load system-wide locale from /etc/default/locale (must happen before boot messages)
      const localeSpan = tracer.startSpan('kernel.boot.locale', {}, trace.setSpan(context.active(), bootSpan))
      try {
        const localeFilePath = '/etc/default/locale'
        let systemLocale = 'en_US'
        
        if (await this.filesystem.fs.exists(localeFilePath)) {
          const localeContent = await this.filesystem.fs.readFile(localeFilePath, 'utf-8')
          // Parse locale file: handle comments, quotes, and various formats
          // Examples: LANG=en_US, LANG="en_US", LANG='en_US', # comment, LANG=en_US.UTF-8
          for (const line of localeContent.split('\n')) {
            const trimmedLine = line.trim()
            // Skip empty lines and comments
            if (!trimmedLine || trimmedLine.startsWith('#')) continue
            
            const match = trimmedLine.match(/^LANG\s*=\s*(.+)$/)
            const localeValue = match?.[1]
            if (localeValue) {
              // Remove quotes and whitespace, then remove .UTF-8 suffix if present
              const cleaned = localeValue.trim().replace(/^["']|["']$/g, '')
              const parts = cleaned.split('.')
              systemLocale = parts[0] || 'en_US'
              break
            }
          }
        } else {
          // Create default locale file if it doesn't exist
          await this.filesystem.fs.writeFile(localeFilePath, 'LANG=en_US\n', { mode: 0o644 })
        }
        
        // Detect browser language and override default system locale
        const browserLanguage = this.i18n.detectBrowserLanguage()
        const browserLocale = this.i18n.languageToLocale(browserLanguage)
        const systemLanguage = this.i18n.localeToLanguage(systemLocale)
        
        let finalLocale = systemLocale
        const isDefaultLanguage = browserLanguage === 'en' || browserLanguage.toLowerCase().startsWith('en-')
        
        if (!isDefaultLanguage && browserLanguage !== systemLanguage) {
          finalLocale = browserLocale
          await this.filesystem.fs.writeFile(localeFilePath, `LANG=${finalLocale}\n`, { mode: 0o644 })
          localeSpan.setAttribute('locale.overridden', true)
          localeSpan.setAttribute('locale.browser', browserLanguage)
        }
        
        this.i18n.setLanguage(finalLocale)
        t = this.i18n.i18next.getFixedT(this.i18n.language, 'kernel')
        localeSpan.setAttribute('locale.system', systemLocale)
        localeSpan.setAttribute('locale.final', finalLocale)
        localeSpan.setAttribute('locale.language', this.i18n.language)
      } catch (error) {
        this.log.warn(`Failed to load system locale: ${(error as Error).message}`)
        localeSpan.recordException(error as Error)
        this.i18n.setLanguage('en_US')
        t = this.i18n.i18next.getFixedT(this.i18n.language, 'kernel')
      }
      localeSpan.end()

      // Show verbose boot messages
      if (!options.silent && this.log) {
        const figletFont = options.figletFontRandom
          ? DefaultFigletFonts[Math.floor(Math.random() * DefaultFigletFonts.length)]
          : options.figletFont
            || cssVariable('--figlet-font')
            || 'Poison'
            

        const figletColor = options.figletColor
          || cssVariable('--figlet-color')
          || '#00FF00'

        const colorFiglet = (color: string, text: string) => {
          const rgb = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
          if (rgb) return chalk.rgb(parseInt(rgb[1] ?? 'FF'), parseInt(rgb[2] ?? 'FF'), parseInt(rgb[3] ?? 'FF'))(text)
          if (color.startsWith('#')) return chalk.hex(color)(text)
          return (chalk as unknown as { [key: string]: (text: string) => string })[color]?.(text) || text
        }

        let logoFiglet: string | undefined
        try {
          // Poison is the default Figlet font
          const loadedFont = await import('figlet/importable-fonts/Poison.js')
          figlet.parseFont(figletFont || 'Poison', loadedFont.default)
          logoFiglet = figlet.textSync(import.meta.env['FIGLET_TEXT'] || 'ECMAOS', { font: figletFont as keyof typeof figlet.fonts })
          // The logo is shown only when the page is at least 650px wide
          if ((globalThis.document?.body?.clientWidth ?? Infinity) >= 650) this.terminal.writeln(colorFiglet(figletColor, logoFiglet))
        } catch (error) {
          this.log.error(`Failed to load figlet font ${figletFont}: ${(error as Error).message}`)
        }

        const dependencyLinks = [
          { name: '@xterm/xterm', link: this.terminal.createSpecialLink('https://github.com/xtermjs/xterm.js', '@xterm/xterm') + `@${import.meta.env['XTERM_VERSION']}` },
          { name: '@zen-fs/core', link: this.terminal.createSpecialLink('https://github.com/zen-fs/core', '@zenfs/core') + `@${import.meta.env['ZENFS_VERSION']}` },
        ]

        this.terminal.writeln(chalk.red.bold(`🐉  ${this.i18n.ns.kernel('experimental')} 🐉`))
        this.terminal.writeln(
          `${this.terminal.createSpecialLink(import.meta.env['HOMEPAGE'], import.meta.env['NAME'] || 'ecmaOS')}@${import.meta.env['VERSION']}`
          + chalk.cyan(` [${dependencyLinks.map(link => link.link).join(', ')}]`))

        const author = jsonEnv<{ name?: string, email?: string, url?: string }>(import.meta.env['AUTHOR'])
        this.terminal.writeln(`${this.i18n.ns.kernel('madeBy')} ${this.terminal.createSpecialLink(
          author?.url || 'https://github.com/mathiscode',
          `${author?.name} <${author?.email}>`
        )}`)

        this.terminal.writeln(import.meta.env['REPOSITORY'] + '\n')

        const knownIssues = jsonEnv<string[]>(import.meta.env['KNOWN_ISSUES'])
        if (
          knownIssues
          && import.meta.env['ECMAOS_BOOT_DISABLE_ISSUES'] !== 'true'
          && !this.filesystem.fsSync.existsSync('/etc/noissues')
        ) {
          this.terminal.writeln(chalk.yellow.bold(this.i18n.ns.kernel('knownIssues')))
          this.terminal.writeln(chalk.yellow(knownIssues.map((issue: string) => `- ${issue}`).join('\n')) + '\n')
        }

        if (
          import.meta.env['ECMAOS_BOOT_DISABLE_TIPS'] !== 'true'
          && !this.filesystem.fsSync.existsSync('/etc/notips')
        ) {
          const tipsList = this.i18n.ns.kernel('tipsList', { returnObjects: true }) as string[]
          const fallbackTips = jsonEnv<string[]>(import.meta.env['TIPS'])
          if (Array.isArray(tipsList) && tipsList.length > 0) {
            this.terminal.writeln(chalk.green.bold(this.i18n.ns.kernel('tips')))
            this.terminal.writeln(chalk.green(tipsList.map(tip => `- ${tip}`).join('\n')) + '\n')
          } else if (fallbackTips) {
            this.terminal.writeln(chalk.green.bold(this.i18n.ns.kernel('tips')))
            this.terminal.writeln(chalk.green(fallbackTips.map((tip: string) => `- ${tip}`).join('\n')) + '\n')
          }
        }

        spinner = this.terminal.spinner('arrow3', chalk.yellow(this.i18n.ns.common('Booting')))
        spinner.start()

        if (logoFiglet && import.meta.env['ECMAOS_BOOT_DISABLE_LOGO_CONSOLE'] !== 'true') {
          console.log(`%c${logoFiglet}`, 'color: green')
          console.log(`%c${import.meta.env['REPOSITORY'] || 'https://github.com/ecmaos/ecmaos'}`, 'color: blue; text-decoration: underline; font-size: 16px')
          this.log.info(`${import.meta.env['NAME'] || 'ecmaOS'} v${import.meta.env['VERSION']}`)
        }

        const notifications = this.host.platform.notifications
        if (notifications?.permission() === 'default') notifications.request()
        if (notifications?.permission() === 'denied') this.log.warn(t('kernel.permissionNotificationDenied', 'Notification permission denied'))

        this.intervals.set('title-blink', () => {
          // Guards against firing after a test environment has torn down `document` - this
          // interval otherwise outlives the Kernel instance that created it (nothing disposes it).
          if (!globalThis.document) return
          globalThis.document.title = globalThis.document.title.includes('_') ? 'ecmaos# ' : 'ecmaos# _'
        }, 600)

        this.dom.toast.success(`${import.meta.env['NAME']} v${import.meta.env['VERSION']}`)
        this.dom.showTtyIndicator(this._activeTty)
      }

      if (await this.filesystem.fs.exists('/run')) {
        const entries = await this.filesystem.fs.readdir('/run')
        for (const entry of entries) {
          const entryPath = `/run/${entry}`
          try {
            const stat = await this.filesystem.fs.stat(entryPath)
            if (stat.isFile()) {
              await this.filesystem.fs.unlink(entryPath)
            } else if (stat.isDirectory()) {
              const subEntries = await this.filesystem.fs.readdir(entryPath)
              for (const subEntry of subEntries) {
                await this.filesystem.fs.unlink(`${entryPath}/${subEntry}`)
              }
              await this.filesystem.fs.rmdir(entryPath)
            }
          } catch { /* best-effort cleanup */ }
        }
      }

      // Log to /var/log/kernel.log, through the filesystem the kernel writes through: root's, whoever is logged in
      const logFile = this._logFile = new LogFile(this.filesystem.fs, '/var/log/kernel.log')
      this.log.attachTransport((logObj) => {
        if (!logObj._meta) return
        const formattedDate = new Date(logObj._meta.date).toLocaleString(this.memory.config.get('locale') as string || 'en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          fractionalSecondDigits: 3,
          hour12: false
        }).replace(',', '')

        logFile.write(`${formattedDate} [${logObj._meta?.logLevelName}] ${logObj[0] || logObj.message}\n\n`)
      })

      // Load core kernel features
      await this.registerEvents()
      // Mounts the standard `/dev` memory devices (null, zero, full, random, urandom) from `@zenfs/linux`.
      initKobjects()
      initDriverCore()
      initMemDevices()
      populatePlatformBus()
      // Programs start on workers made ready ahead of time
      installWarmThreads()

      // Registers the xterm and console drivers (`/dev/xterm<n>`, `/dev/tty`, `/dev/console`); without this, reads
      // and writes on those nodes throw ENXIO. Host stdio probing is off.
      tty.params.get('probe')?.store('0')
      await tty.init()

      await this.registerDevices()
      installEvdevIoctl()
      if (!registerGlControl()) this.log.warn('OpenGL ES is unavailable: another driver holds the major of /dev/gl')
      if (globalThis.document) captureDom(globalThis.document)
      await this.registerCommands()
      await this.registerPackages()

      // Load and process fstab
      const fstabSpan = tracer.startSpan('kernel.boot.fstab', {}, trace.setSpan(context.active(), bootSpan))
      await this.loadFstab()
      fstabSpan.end()

      // Load kernel modules
      const modulesSpan = tracer.startSpan('kernel.boot.modules', {}, trace.setSpan(context.active(), bootSpan))
      const modules = import.meta.env['ECMAOS_KERNEL_MODULES']
      if (modules) {
        const mods = modules.split(',')
        modulesSpan.setAttribute('modules.count', mods.length)
        for (const mod of mods) {
          try {
            const spec = mod.match(/(@[^/]+\/[^@]+|[^@]+)(?:@([^/]+))?/)
            const name = spec?.[1]
            const version = spec?.[2]

            if (!name) { this.log.error(`Failed to load module ${mod}: Invalid package name format`); continue }
            if (!version) { this.log.error(`Failed to load module ${mod}: No version specified`); continue }

            this.log.info(`Loading module ${name}@${version}`)
            const [scope, pkg] = name.split('/')
            const pkgPath = `/usr/lib/${scope ? `${scope}/` : ''}${pkg}/${version}`
            const exists = await this.filesystem.fs.exists(pkgPath)

            let result
            if (!exists) {
              result = await this.shell.execute(`/bin/install ${name}@${version}`)
              if (result !== 0) throw new Error(`Failed to install module ${name}@${version}: ${result}`)
              if (!await this.filesystem.fs.exists(pkgPath)) throw new Error(`Failed to install module ${name}@${version}: ${result}`)
            }

            // load its main export from package.json
            const pkgJson = await this.filesystem.fs.readFile(`${pkgPath}/package.json`, 'utf-8')
            const pkgData = JSON.parse(pkgJson) as JSONSchemaForNPMPackageJsonFiles
            const mainFile = this.getPackageMainExport(pkgData)
            if (!mainFile) throw new Error(`Failed to load module ${name}@${version}: No main export found`)
            const mainPath = path.join(pkgPath,  mainFile)

            // Importing from a blob objectURL doesn't work for some reason, so use SWAPI
            const loaded = await import(/* @vite-ignore */ `/swapi/fs${mainPath}`) as KernelModule
            const modname = loaded.name?.value || mod

            // A real `@zenfs/linux` Module (refcounting, `/sys/module/<name>`); a package's own init and cleanup run
            // from its lifecycle.
            const zenfsModule = new ZenFSModule({
              name: modname,
              version: pkgData.version,
              description: loaded.description?.value ?? pkgData.description,
              author: loaded.author?.value ?? (typeof pkgData.author === 'string' ? pkgData.author : undefined),
              init: async () => { loaded.init?.(this.id) },
              exit: async () => { loaded.cleanup?.() }
            })

            await zenfsModule.init()
            this.modules.set(modname, loaded)
          } catch (error) {
            this.log.error(`Failed to load module ${mod}: ${(error as Error).message}`)
          }
        }
      }

      // Setup root user or load existing users
      const usersSpan = tracer.startSpan('kernel.boot.users', {}, trace.setSpan(context.active(), bootSpan))
      try {
        if (!await this.filesystem.fs.exists('/etc/passwd')) {
          await this.users.add({ username: 'root', password: 'root', home: '/root' }, { noHome: true })
          usersSpan.setAttribute('users.action', 'create_root')
        } else {
          await this.users.load()
          usersSpan.setAttribute('users.action', 'load')
        }
        // `/etc/sudoers` grants %sudo, so the group has to exist for anyone to be put in it (27 as on Debian)
        await this.users.ensureGroup('sudo', 27)
        // `/etc/shadow` is `0640 root:shadow` (42 as on Debian); the file may predate the group, so set it again now
        await this.users.ensureGroup(SHADOW_GROUP, SHADOW_GID)
        await this.users.secureShadow()
        usersSpan.setAttribute('users.count', this.users.all.size)
        await this.loadQuotas()
      } catch (err) {
        usersSpan.recordException(err as Error)
        usersSpan.setStatus({ code: 2, message: (err as Error).message })
        this.log.error(err)
        this.terminal.writeln(chalk.red((err as Error).message))
        usersSpan.end()
        throw err
      }

      usersSpan.end()
      spinner?.stop()
      this.dom.topbar()

      // Show login prompt or auto-login
      const authSpan = tracer.startSpan('kernel.boot.authentication', {}, trace.setSpan(context.active(), bootSpan))
      const autoLogin = this.options.credentials
        ? { username: this.options.credentials.username, password: this.options.credentials.password }
        : undefined
      
      // With a getty on TTY 0 in /etc/inittab, init starts the login prompt and the kernel does not.
      this._gettyTtys = this.options.credentials || !await this.filesystem.fs.exists('/sbin/getty')
        ? new Set()
        : gettyTerminals(await this.filesystem.fs.readFile('/etc/inittab', 'utf-8'))
      const gettyLogin = !autoLogin && this._gettyTtys.has(0)
      if (!gettyLogin) {
        await this.loginShell(this.shell, autoLogin ? { autoLogin } : undefined)
        // With a getty the message of the day is printed after login by getty; otherwise here.
        const motd = await this.filesystem.fs.exists('/etc/motd') ? await this.filesystem.fs.readFile('/etc/motd', 'utf-8') : null
        if (motd) this.terminal.writeln('\n' + motd)
      }

      if (autoLogin) {
        authSpan.setAttribute('auth.method', 'auto_login')
        authSpan.setAttribute('auth.username', autoLogin.username)
      }
      authSpan.end()

      if (!gettyLogin) {
        const user = this.users.get(this.shell.credentials.uid ?? 0)
        if (!user) throw new Error(t('kernel.userNotFound', 'User not found'))

        this.shell.credentials = {
          uid: user.uid,
          gid: user.gid,
          suid: user.uid,
          sgid: user.gid,
          euid: user.uid,
          egid: user.gid,
          groups: user.groups
        }
      }

      this.registerScreensavers()

      const initSpan = tracer.startSpan('kernel.boot.init', {}, trace.setSpan(context.active(), bootSpan))
      if (!await this.filesystem.fs.exists('/boot/init')) {
        await this.filesystem.fs.writeFile('/boot/init', DEFAULT_BOOT_INIT)
      }
      // /sbin/init runs /etc/inittab: /boot/init as a sysinit entry, crond as a respawn entry. Boot
      // waits for the sysinit and wait entries, so /boot/init's own output (motd, screensaver-daemon,
      // ...) finishes printing before the recommended-apps prompt below writes its own.
      await this.init.start(this)
      if (!await this.init.waitForBoot(INIT_BOOT_TIMEOUT_MS)) {
        this.log.error(`/sbin/init did not finish its sysinit entries within ${INIT_BOOT_TIMEOUT_MS / 1000}s; carrying on`)
      }
      initSpan.end()

      this._state = KernelState.RUNNING
      this.setupDebugGlobals()
      this._startPrograms?.()
      
      bootSpan.setAttribute('kernel.state', this._state)
      bootSpan.end()
      
      if (this.telemetry.active) {
        const provider = (this.telemetry as unknown as { _provider?: { forceFlush?: () => Promise<void> } })._provider
        if (provider?.forceFlush) {
          await provider.forceFlush().catch(() => {})
        }
      }

      // Install recommended apps if desired by user on first boot
      if (!this.storage.local.getItem(this.machineKey('ecmaos:first-boot'))) {
        const recommendedApps = import.meta.env['ECMAOS_RECOMMENDED_APPS']
        if (recommendedApps) {
          const apps = recommendedApps.split(',')
          this.terminal.writeln('\n' + chalk.yellow.bold(this.i18n.ns.kernel('recommendedApps')))
          this.terminal.writeln(chalk.green(apps.map((app: string) => `- ${app}`).join('\n')))
          this.terminal.write(chalk.green.bold(this.i18n.ns.kernel('installRecommendedApps')))

          const answer = await this.terminal.readline()
          if (answer.toLowerCase()[0] === 'y' || answer === '') {
            for (const app of apps) await this.shell.execute(`/bin/install --reinstall ${app}`)
          }
        }

        this.storage.local.setItem(this.machineKey('ecmaos:first-boot'), Date.now().toString())
      }

      if (!gettyLogin) {
        await this.enterLoginShell(this.shell)

        this.terminal.write(ansi.erase.inLine(2) + this.terminal.prompt())
        this.terminal.focus()
        this.terminal.listen()
      }
      // With the kernel not drawing a prompt, the keyboard still has to be somewhere for getty to read.
      if (gettyLogin) this.terminal.focus()
      this._isReady = true
      this._ready.resolve()
    } catch (error) {
      bootSpan.recordException(error as Error)
      bootSpan.setStatus({ code: 2, message: (error as Error).message })
      bootSpan.setAttribute('kernel.state', KernelState.PANIC)
      bootSpan.end()
      this.log.error(error)
      this._state = KernelState.PANIC
      this.showBootFailure(error, spinner)
      this.events.dispatch<KernelPanicEvent>(KernelEvents.PANIC, { error: error as Error })
    }
  }

  /**
   * Leaves the UI in a usable state after `boot()` fails: the spinner stops, the topbar and its
   * progress clear, and a toast names the error. Each step is guarded on its own, because the
   * failure may have come from the very subsystem (dom, i18n, terminal) the step would use.
   */
  private showBootFailure(error: unknown, spinner?: { stop(): void }) {
    const detail = error instanceof Error ? error.message : String(error)

    try { spinner?.stop() } catch { /* the spinner may already be gone */ }
    try {
      void this.dom.topbarProgress(0)
      void this.dom.topbar(false)
    } catch { /* no DOM to update */ }

    let headline = 'Uh oh, kernel panic! Check the logs for more details.'
    try {
      const translated = this.i18n.ns.kernel('panic')
      if (translated && translated !== 'panic') headline = translated
    } catch { /* keep the untranslated headline */ }

    const message = detail ? `${headline}\n${detail}` : headline
    try {
      this.dom.toast.error({ message, duration: 0, dismissible: false })
    } catch {
      console.error(message)
    }
  }

  /**
   * Configures kernel subsystems with the provided options
   * @param options - Configuration options for kernel subsystems
   */
  async configure(options: KernelOptions) {
    await this.filesystem.configure(options.filesystem ?? {})
  }

  /**
   * Gets the main entry file path from a package.json
   * @param pkgData - The parsed package.json data
   * @returns The main entry file path or null if not found
   */
  getPackageMainExport(pkgData: JSONSchemaForNPMPackageJsonFiles): string | null {
    let mainFile = null

    if (pkgData.exports) {
      const exportPaths = [
        './browser',
        '.',
        './index',
        './module',
        './main'
      ]
      
      for (const path of exportPaths) {
        const entry = (pkgData.exports as Record<string, unknown>)[path]
        if (typeof entry === 'string') {
          mainFile = entry
          break
        } else if (typeof entry === 'object' && entry !== null) {
          const subPaths = ['browser', 'module', 'default', 'import']
          for (const subPath of subPaths) {
            if (typeof (entry as Record<string, unknown>)[subPath] === 'string') {
              mainFile = (entry as Record<string, unknown>)[subPath]
              break
            }
          }

          if (mainFile) break
        }
      }
    }

    // Fallback to package.json's older main-entry fields if `exports` didn't yield a result
    if (!mainFile) {
      mainFile = pkgData.browser || pkgData.module || pkgData.main

      // Handle browser field if it's an object (remapping)
      if (typeof mainFile === 'object') {
        for (const key of Object.keys(mainFile)) {
          if (typeof mainFile[key] === 'string') {
            mainFile = mainFile[key]
            break
          }
        }
      }
    }

    return mainFile
  }

  /**
   * Executes a command in the kernel environment
   * @param options - Execution options containing command, args, and shell
   * @returns Exit code of the command
   */
  /** For a path that cannot take `stdinFile` as a descriptor: the same input as a stream */
  private withStdinStream(options: KernelExecuteOptions): KernelExecuteOptions {
    if (!options.stdinFile || options.stdin) return options
    return { ...options, stdin: options.openStdin?.(), stdinFile: undefined, openStdin: undefined }
  }

  async execute(options: KernelExecuteOptions): Promise<number> {
    try {
      if (!await this.filesystem.exists(options.command)) {
        this.log.error(`File not found for execution: ${options.command}`)
        return -1
      }

      const header = await this.readFileHeader(options.command, options.shell) ?? { type: 'application/octet-stream' as const }

      let exitCode: number | void = -1
      switch (header.type) {
        case 'wasm': {
          // A plain wasip1 module runs as a real worker Process under /bin/wali (killable, real
          // pid, real pipes); the rest still need the main-thread adapter.
          const wasmBytes = await options.shell.context.fs.promises.readFile(options.command)
          exitCode = await this.wasm.canRunInWorker(wasmBytes)
            ? await this.executeViaExecve(options)
            : await this.executeWasm(this.withStdinStream(options))
          break
        }
        case 'js':
          exitCode = await this.executeViaExecve(options)
          break
        case 'view':
          exitCode = await this.execute({
            ...options,
            command: '/bin/view',
            args: [options.command, ...(options.args || [])]
          })
          break
        case 'bin':
          switch (header.namespace) {
            case 'command':
              if (!header.name) return -1
              exitCode = await this.executeCommand({ ...this.withStdinStream(options), command: header.name })
              break
            case 'program':
            case 'app':
              // Both run under /bin/app: a `program` in its worker, an `app` (DOM) via the app presenter
              exitCode = await this.execute({
                ...options,
                command: '/bin/app',
                args: [options.command, ...(options.args || [])]
              })
              break
            case 'script':
              exitCode = await this.executeScript(this.withStdinStream(options))
              break
            // `interpreter` is a real `#!/path` shebang: upstream `binfmt_script` resolves the
            // interpreter and rewrites argv once `executeViaExecve` hands it the path untouched.
            // See `readFileHeader`.
            case 'node':
            case 'interpreter':
              exitCode = await this.executeViaExecve(options)
              break
            case 'device': {
              if (!header.name) return -1
              if (!this.devices.get(header.name)?.device.cli) return -1
              exitCode = await this.execute({
                ...options,
                command: '/bin/devcli',
                args: [header.name, ...(options.args || [])]
              })
              break
            }
          }; break
        default: {
          // execve's ENOEXEC: a file that is neither a known format nor a shebang runs as a shell script when it is
          // text, as bash and /bin/sh do; anything with a NUL byte is a binary this system cannot run.
          const head = await options.shell.context.fs.promises.readFile(options.command).then(b => new Uint8Array(b).subarray(0, 512))
          if (head.includes(0)) {
            const message = `${options.command}: cannot execute binary file: Exec format error\n`
            if (options.stderr) { const w = options.stderr.getWriter(); await w.write(new TextEncoder().encode(message)); w.releaseLock() }
            else this.terminal.write(`\x1b[31m${message.replace(/\n/g, '\r\n')}\x1b[0m`)
            exitCode = 126
          } else {
            exitCode = await this.runScriptFile(this.withStdinStream(options))
          }
        }
      }

      exitCode = exitCode ?? 0
      options.shell.env.set('?', exitCode.toString())
      this.events.dispatch<KernelExecuteEvent>(KernelEvents.EXECUTE, { command: options.command, args: options.args, exitCode })
      return exitCode
    } catch (error) {
      console.error(error)
      this.log.error(error)
      options.shell.env.set('?', '-1')
      return -1
    }
  }

  /**
   * Executes a terminal command
   * @param options - Execution options containing command name, args, shell, and terminal
   * @returns Exit code of the command
   */
  async executeCommand(options: KernelExecuteOptions): Promise<number> {
    const terminal = options.terminal || this.terminal
    const shell = options.shell || this.shell
    const kernel = options.kernel || this
    // Reached only for commands resolved through the in-process shim path; see `resolveLegacyCommand`.
    const command = resolveLegacyCommand(kernel, shell, terminal, options.command)
    if (!command) return -1

    // An in-process command has no process entry. A stream it was handed (pipe, redirect) is closed afterwards so the
    // far end sees EOF; the terminal's shared streams are left open.
    const stdin = options.stdin ?? terminal.getInputStream()
    const stdout = options.stdout ?? terminal.stdout ?? new WritableStream<Uint8Array>()
    const stderr = options.stderr ?? terminal.stderr ?? new WritableStream<Uint8Array>()
    const invocation: CommandInvocation = {
      pid: 0,
      command: options.command,
      args: options.args ?? [],
      uid: shell.credentials.uid,
      gid: shell.credentials.gid,
      stdin,
      stdout,
      stderr,
      stdinIsTTY: options.stdinIsTTY ?? (options.stdin ? false : true),
      stdoutIsTTY: options.stdoutIsTTY ?? (options.stdout ? false : true)
    }

    try {
      return (await command.run(invocation.pid, invocation.args, invocation)) ?? 0
    } finally {
      if (stdin !== terminal.stdin) await stdin.cancel().catch(() => {})
      if (stdout !== terminal.stdout) await stdout.close().catch(() => {})
      if (stderr !== terminal.stderr) await stderr.close().catch(() => {})
    }
  }

  /**
   * Runs a plain JS/ESM file as an isolated process through `@zenfs/linux`'s `execve`, with `/bin/node` as
   * interpreter. Redirected stdio is wired through `bridgeStdio`. A program cannot import modules itself.
   * @param options - the file path and shell
   * @returns the process's exit code
   */
  async executeViaExecve(options: KernelExecuteOptions): Promise<number> {
    if (!options.command) return -1
    const terminal = options.terminal || this.terminal
    const tty = terminal.zfsTty
    const isForeground = options.foreground ?? true

    // `tty->pgrp`: a foreground stage takes it over for as long as it runs; a backgrounded one never does. The
    // previous value is restored so a nested foreground process (`su`, `sudo`) hands control back up.
    const previousForeground = tty?.foreground
    const stopBridges: Array<() => void> = []
    // Only for the `finally` block below to check `tty.foreground === liveProc` after the process
    // exits - everything else in this method still uses the `const proc` declared inside `try`.
    let liveProc: InstanceType<typeof ZenFSProcess> | undefined

    try {
      const proc = new ZenFSProcess({
        argv: [options.command, ...(options.args || [])],
        env: options.shell.envObject,
        cwd: options.shell.cwd,
        context: this.processContext(options.shell, options.shell.cwd, options.command),
        tty,
        // Process opens stdio against this path, not `tty` directly - `tty` only sets the
        // foreground-process/signal-delivery side of things.
        console: tty ? `/dev/${tty.name}` : undefined
      })
      liveProc = proc
      this.init.adopt(proc)
      setUmask(proc, (options.shell as { umask?: number }).umask ?? DEFAULT_UMASK)

      // Custom syscalls whose handler needs a `Kernel` (e.g. `window_create`) resolve it from the
      // calling `Process` - `@zenfs/linux`'s `Process` has no notion of "kernel" itself, and the
      // syscall table is module-global, shared across every `Kernel` instance in the page/process.
      registerProcessKernel(proc, this, options.shell)

      if (tty && isForeground) tty.foreground = proc

      // A foreground stage owns the keyboard through the line discipline (see `Terminal.attachInput`); `fg`, `bg` and
      // `^Z` move it through `setForeground`.
      let releaseInput: (() => void) | undefined
      const grabInput = () => { releaseInput ??= terminal.attachInput() }
      const dropInput = () => { releaseInput?.(); releaseInput = undefined }
      if (tty && isForeground) grabInput()
      stopBridges.push(dropInput)

      // The line discipline raises `^Z` as `SIGTSTP` straight on the process, and `@zenfs/linux`
      // only flips `proc.stopped` - it emits nothing - so observe the transition here, where the
      // signal lands, to hand the terminal back to the shell.
      const deliver = proc.kill.bind(proc)
      proc.kill = (signal) => {
        const wasStopped = proc.stopped
        const delivered = deliver(signal)
        // (a program that stops itself because what it runs was stopped, as `sudo` does, is the job's process
        // while the terminal's foreground is its child)
        if (!wasStopped && proc.stopped && isForeground && (tty?.foreground === proc || options.shell.foregroundJob?.processes.some(p => p.pid === proc.pid))) {
          dropInput()
          terminal.foregroundStopped()
        }
        return delivered
      }

      // Only descriptors given a real stream, other than the plain console, are bridged. `drainable` collects bridges
      // whose output has a final destination; see `drainBeforeExit`.
      const drainable: Array<Promise<void>> = []
      const bridge = (fd: 0 | 1 | 2, stream: ReadableStream<Uint8Array> | WritableStream<Uint8Array>, drain: boolean) => {
        const { stop, done } = this.bridgeStdio(proc, fd, stream)
        stopBridges.push(stop)
        if (drain) drainable.push(done)
      }

      // A stdin shared with the shell (a redirected block's) is not consumed by the process, only
      // read from: whatever it left in the pipe goes back to the shell once it has exited.
      let unreadStdin: (() => Promise<Uint8Array>) | undefined
      if (options.stdinFile) {
        // `cmd < file`: the file is the program's descriptor 0 itself, opened as the program, so it can `fstat` and seek it and
        // `/proc/<pid>/fd/0` names it. Closing the console's fd 0 first makes the open take that number.
        zenfsFs.closeSync.call(proc.context, 0)
        const fd = zenfsFs.openSync.call(proc.context, options.stdinFile, 'r')
        if (fd !== 0) {
          const handle = proc.context.descriptors.get(fd)
          proc.context.descriptors.delete(fd)
          if (handle) proc.context.descriptors.set(0, handle)
        }
      } else if (options.stdin && !options.stdinIsTTY) {
        const bridged = this.bridgeStdio(proc, 0, options.stdin)
        stopBridges.push(bridged.stop)
        if (options.stdinLeftover) unreadStdin = bridged.unread
      }
      const stdoutBridged = Boolean(options.stdout && !options.stdoutIsTTY)
      if (stdoutBridged) bridge(1, options.stdout as WritableStream<Uint8Array>, options.drainStdout === true)
      // Descriptors that go to the same place (`> f 2>&1`, `&> f`) share one pipe so their output stays ordered.
      // Bridging one stream twice would fail, since `.getWriter()` throws on a locked stream.
      if (options.stderr) {
        if (stdoutBridged && sharesDestination(options.stdout, options.stderr)) {
          // a second descriptor on the open file, so closing one (`dup2` over fd 2) leaves the other open
          const shared = proc.context.descriptors.get(1)
          if (shared) proc.context.descriptors.set(2, shared.ref())
        } else {
          // fd 2 is never a pipe to another stage - `Shell.buildOutputStreams` only ever gives it the
          // terminal or a file - so its drain is always safe to await and always worth awaiting.
          bridge(2, options.stderr, true)
        }
      }

      // Hands the process to the shell's job table before awaiting it; `setForeground` lets `fg` and `bg` move
      // terminal ownership later.
      options.onProcess?.(tty
        ? Object.assign(proc, {
          setForeground: (want: boolean) => {
            tty.foreground = want ? proc : (tty.foreground === proc ? undefined : tty.foreground)
            if (want) grabInput()
            else dropInput()
          }
        })
        : proc)

      await zenfsExecve(proc, options.command, [options.command, ...(options.args || [])], options.shell.envObject)

      // `execve()` always sets `tty.foreground = proc`; a backgrounded (`&`) stage puts it back.
      if (tty && !isForeground && tty.foreground === proc) tty.foreground = previousForeground

      const exitCode = await proc.exited

      // The line discipline echoes `^C` without a newline, so one is written here. This is also where the shell
      // learns of an interactive `^C` (see `Shell.notifyInterrupted`), once per interrupt rather than once per stage.
      if (isForeground && proc.killed_by === ZenFSSignal.INT && options.shell.claimInterrupt()) {
        // The echo is a tty concern (only a line discipline wrote a bare `^C` needing a newline);
        // the shell-side effects are not, so they run whether or not a terminal is attached.
        if (tty) terminal.write('\r\n')
        await options.shell.notifyInterrupted()
      }

      // Waits for bridges writing to a final destination to finish, so `cmd > f` has every byte in `f` when this
      // returns. Mid-pipeline stdout is excluded (`drainStdout`): a downstream program that exits early would leave
      // the drain waiting forever.
      await Promise.all(drainable)
      if (unreadStdin && options.stdinLeftover) {
        const rest = await unreadStdin()
        if (rest.byteLength) options.stdinLeftover(rest)
      }

      return exitCode
    } catch (error) {
      this.log.error(`Failed to execute ${options.command}: ${error}`)
      terminal?.writeln(chalk.red(error instanceof Error ? error.message : String(error)))
      if (liveProc && liveProc.code === undefined) liveProc.exit(-1)
      return -1
    } finally {
      for (const stop of stopBridges) stop()
      // `isForeground` is how the process was spawned, not its state now (`Shell.fg()` can promote it), so the live
      // `tty.foreground` is checked to release the terminal.
      if (tty && tty.foreground === liveProc) tty.foreground = previousForeground
    }
  }

  /**
   * Replaces `proc`'s fd `stdFd` (0/1/2) with one end of a `create_pipe` pipe and pumps the other end against
   * `stream` on the main thread.
   * The pipe lives on `pipeProcess`'s context so it outlives the program's exit; the program's end is copied into
   * `proc.context.descriptors` at the standard slot.
   * It uses `read_device` and `write_device` from `fs/pipe.ts`, since `@zenfs/core`'s generic `readSync`/`writeSync`
   * do not work on a pipe. The pump polls because `read_device` does not block.
   */
  private bridgeStdio(
    proc: InstanceType<typeof ZenFSProcess>,
    stdFd: 0 | 1 | 2,
    stream: ReadableStream<Uint8Array> | WritableStream<Uint8Array>
  ): { stop: () => void, done: Promise<void>, unread: () => Promise<Uint8Array> } {
    // fd 0 is the program's stdin: it reads from the pipe we write into
    return this.bridgeFd(proc, stdFd, stdFd === 0 ? 'read' : 'write', stream)
  }

  /**
   * Gives `proc` a new descriptor (lowest free from 3) that is one end of a pipe pumped against `stream`, and returns
   * its number; `'read'` yields what `stream` produces, `'write'` delivers to it. Used for kernel-side resources such
   * as sockets.
   */
  attachStream(
    proc: InstanceType<typeof ZenFSProcess>,
    direction: 'read' | 'write',
    stream: ReadableStream<Uint8Array> | WritableStream<Uint8Array>
  ): { fd: number, stop: () => void, done: Promise<void> } {
    let fd = 3
    while (proc.context.descriptors.has(fd)) fd++
    const { stop, done } = this.bridgeFd(proc, fd, direction, stream, { closeOnEof: true })
    return { fd, stop, done }
  }

  /**
   * A directed `create_pipe` between two processes with no pump. A loopback socket connection is two of these, one
   * per direction. Both ends are created on `pipeProcess` and each `Handle` moves to its process's table at the
   * lowest free fd.
   */
  linkProcesses(fromProc: InstanceType<typeof ZenFSProcess>, toProc: InstanceType<typeof ZenFSProcess>): { writerFd: number, readerFd: number } {
    const pipeProcCtx = this.pipeProcess.context
    const [pipeReadFd, pipeWriteFd] = createPipe(pipeProcCtx)

    const readHandle = pipeProcCtx.descriptors.get(pipeReadFd)
    pipeProcCtx.descriptors.delete(pipeReadFd)
    let readerFd = 3
    while (toProc.context.descriptors.has(readerFd)) readerFd++
    if (readHandle) toProc.context.descriptors.set(readerFd, readHandle)

    const writeHandle = pipeProcCtx.descriptors.get(pipeWriteFd)
    pipeProcCtx.descriptors.delete(pipeWriteFd)
    let writerFd = 3
    while (fromProc.context.descriptors.has(writerFd)) writerFd++
    if (writeHandle) fromProc.context.descriptors.set(writerFd, writeHandle)

    return { writerFd, readerFd }
  }

  private bridgeFd(
    proc: InstanceType<typeof ZenFSProcess>,
    stdFd: number,
    direction: 'read' | 'write',
    stream: ReadableStream<Uint8Array> | WritableStream<Uint8Array>,
    // `closeOnEof`: end a `'write'` stream as soon as the program closes its end and what it wrote
    // has drained (shutdown of the write side), instead of only when the program exits. Stdio
    // leaves this off - it has always ended with the process - but a socket needs it to half-close.
    { closeOnEof = false }: { closeOnEof?: boolean } = {}
  ): { stop: () => void, done: Promise<void>, unread: () => Promise<Uint8Array> } {
    const pipeProcCtx = this.pipeProcess.context

    const [pipeReadFd, pipeWriteFd] = createPipe(pipeProcCtx)
    const programFd = direction === 'read' ? pipeReadFd : pipeWriteFd
    const bridgeFd = direction === 'read' ? pipeWriteFd : pipeReadFd

    // The program-facing end's Handle is copied to `proc`'s standard slot and removed from `pipeProcCtx`; the console
    // handle previously there is discarded.
    const programHandle = pipeProcCtx.descriptors.get(programFd)
    pipeProcCtx.descriptors.delete(programFd)
    if (programHandle) proc.context.descriptors.set(stdFd, programHandle)

    const bridgeHandle = pipeProcCtx.descriptors.get(bridgeFd)
    const bridgeFile = bridgeHandle && pipefs._device(bridgeHandle.internalPath)
    if (!bridgeFile) {
      this.log.error(`bridgeStdio: could not resolve fd ${stdFd}'s pipe device; leaving it on the console`)
      return { stop: () => {}, done: Promise.resolve(), unread: async () => new Uint8Array(0) }
    }

    let stopped = false
    const stop = () => { stopped = true }
    /**
     * Resolves when the pump has finished: for a `'write'` bridge, once the program's end is closed and every byte
     * has been written to `stream`. See `KernelExecuteOptions.drainStdout`.
     */
    let done: Promise<void>
    /** A `'read'` pump's chunk that was taken from the stream but not fully written when it stopped */
    let remainder: Uint8Array | undefined

    if (direction === 'write') {
      // stdout/stderr: drain the pipe's read end into `stream` until the program closes its write
      // end (proc.exited) and the pipe is empty.
      const writer = (stream as WritableStream<Uint8Array>).getWriter()
      done = (async () => {
        try {
          while (!stopped) {
            const buffer = new Uint8Array(65536)
            const n = pipefs.read_device(bridgeFile, buffer, 0, buffer.byteLength)
            if (n > 0) {
              await writer.write(buffer.subarray(0, n))
              continue
            }
            // Empty and the program's end is closed: EOF (a pipe polls readable exactly then)
            if (closeOnEof && ((bridgeFile.ops.poll?.(bridgeFile) ?? 0) & 1)) break
            // Sleeps until the program writes, exits, or a fallback tick, so stderr is not delayed behind later
            // stdout. Only for stderr: waking stdout this way loses the tail of large transfers.
            let stopWaiting: (() => void) | undefined
            const written = stdFd === 2
              ? new Promise<boolean>(resolve => { stopWaiting = pipefs._end(bridgeFile.path)?.pipe.wait.wait_with(() => resolve(false)) })
              : new Promise<boolean>(() => {})
            const exited = await Promise.race([proc.exited.then(() => true), written, new Promise<boolean>(resolve => setTimeout(() => resolve(false), stdFd === 2 ? 100 : 10))])
            stopWaiting?.()
            if (exited) {
              // Program has exited (closing its end); drain whatever is left, then stop.
              const drain = new Uint8Array(65536)
              let m: number
              do { m = pipefs.read_device(bridgeFile, drain, 0, drain.byteLength); if (m > 0) await writer.write(drain.subarray(0, m)) } while (m > 0)
              break
            }
          }
        } catch (error) {
          // a reader that finished first is the ordinary end of `yes | head`: the program's next write gets EPIPE
          if ((error as { code?: string })?.code !== 'EPIPE') this.log.error(`stdio bridge (fd ${stdFd}) failed: ${error}`)
        } finally {
          try { pipeProcCtx.descriptors.delete(bridgeFd) } catch { /* already gone */ }
          // A program asleep in a write to a full pipe (`yes | head`) is only woken when data moves, not when the
          // reader's end closes, so wake it to find the end gone (EPIPE) instead of sleeping for ever.
          pipefs._end(bridgeFile.path)?.pipe.wait.wake_up()
          try { await writer.close() } catch { /* already closed by the pipeline's next stage */ }
        }
      })()
    } else {
      const reader = (stream as ReadableStream<Uint8Array>).getReader()
      done = (async () => {
        try {
          while (!stopped) {
            const { done, value } = await reader.read()
            if (done) break
            let offset = 0
            while (offset < value.byteLength) {
              if (stopped) { remainder = value.subarray(offset); break }
              const n = pipefs.write_device(bridgeFile, value.subarray(offset), 0)
              if (n > 0) { offset += n; continue }
              await new Promise(resolve => setTimeout(resolve, 10))
            }
            if (remainder) break
          }
        } catch (error) {
          this.log.error(`stdio bridge (fd ${stdFd}) failed: ${error}`)
        } finally {
          try { pipeProcCtx.descriptors.delete(bridgeFd) } catch { /* already gone */ }
          // Dropping the last write end is what tells a reader the stream is over (EOF), but
          // `@zenfs/linux` only wakes a pipe's sleepers when data moves, not when an end closes - a
          // program blocked in `poll`/`read` on this fd would sleep forever. Wake it ourselves.
          pipefs._end(bridgeFile.path)?.pipe.wait.wake_up()
        }
      })()
    }

    /**
     * What a stopped `'read'` pump put in the pipe that the program never read, then the chunk it had
     * not finished writing: the bytes a program left behind, which a shared descriptor hands back
     * so the next reader carries on from where this one stopped.
     */
    const unread = async () => {
      stopped = true
      await done
      // `buffer` is `protected` in the types only; it is the pipe's plain unread bytes.
      const pipe = pipefs._end(bridgeFile.path)?.pipe as unknown as { buffer: Uint8Array } | undefined
      const inPipe = pipe ? pipe.buffer : new Uint8Array(0)
      if (pipe) pipe.buffer = new Uint8Array(0)
      const rest = new Uint8Array(inPipe.byteLength + (remainder?.byteLength ?? 0))
      rest.set(inPipe)
      if (remainder) rest.set(remainder, inPipe.byteLength)
      return rest
    }

    return { stop, done, unread }
  }

  /**
   * A `create_pipe`-backed replacement for `new TransformStream()`, joining one pipeline stage's stdout to the next
   * stage's stdin.
   * Both ends are anchored on `pipeProcess` (see `bridgeStdio`) and use `read_device` and `write_device`.
   */
  private createPipeStream(): { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, abandon?: () => void } {
    const pipeProcCtx = this.pipeProcess.context
    const [readFd, writeFd] = createPipe(pipeProcCtx)
    const readHandle = pipeProcCtx.descriptors.get(readFd)
    const writeHandle = pipeProcCtx.descriptors.get(writeFd)
    const readFile = readHandle && pipefs._device(readHandle.internalPath)
    const writeFile = writeHandle && pipefs._device(writeHandle.internalPath)

    if (!readFile || !writeFile) {
      this.log.error('createPipeStream: could not resolve a real pipe device; falling back to TransformStream')
      const fallback = new TransformStream<Uint8Array>()
      return { readable: fallback.readable, writable: fallback.writable }
    }

    let writerClosed = false
    // The stage that reads this pipe has finished (`yes | head -n 1`): nothing will ever make room in it
    let readerGone = false
    const broken = () => Object.assign(new Error('Broken pipe'), { code: 'EPIPE' })
    const abandon = () => {
      if (readerGone) return
      readerGone = true
      pipeProcCtx.descriptors.delete(readFd)
    }
    const writable = new WritableStream<Uint8Array>({
      // `write_device` is a short write that returns 0 once the 65536-byte pipe is full, and there is no thread to
      // suspend, so the loop awaits between attempts to let `pull` drain.
      write: async chunk => {
        let offset = 0
        while (offset < chunk.byteLength) {
          if (readerGone) throw broken()
          const n = pipefs.write_device(writeFile, chunk.subarray(offset), 0)
          if (n > 0) { offset += n; continue }
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      },
      close: () => {
        writerClosed = true
        pipeProcCtx.descriptors.delete(writeFd)
      },
      abort: () => {
        writerClosed = true
        pipeProcCtx.descriptors.delete(writeFd)
      }
    })

    const readable = new ReadableStream<Uint8Array>({
      pull: async controller => {
        while (true) {
          const buffer = new Uint8Array(65536)
          const n = pipefs.read_device(readFile, buffer, 0, buffer.byteLength)
          if (n > 0) {
            controller.enqueue(buffer.subarray(0, n))
            return
          }
          if (writerClosed) {
            controller.close()
            return
          }
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      },
      cancel: () => abandon()
    })

    return { readable, writable, abandon }
  }

  /**
   * Executes a WebAssembly file
   * @param options - Execution options containing WASM path and shell
   * @returns Exit code of the WASM execution
   */
  async executeWasm(options: KernelExecuteOptions): Promise<number> {
    const terminal = options.terminal || this.terminal
    const stdinIsTTY = options.stdinIsTTY ?? (options.stdin ? false : true)
    const shouldUnlisten = terminal && stdinIsTTY
    let keyListener: { dispose: () => void } | null = null

    // A real `ZenFSProcess`, so `ps` and `kill` see it. It does not use the line discipline: a JS stdin/stdout
    // `Stream` pair feeds the WASM loader, and the WASI adapters key `^C` off `TerminalEvents.INTERRUPT`.
    const proc = new ZenFSProcess({
      argv: [options.command, ...(options.args || [])],
      env: options.shell.envObject,
      cwd: options.shell.cwd,
      context: this.processContext(options.shell, options.shell.cwd),
      tty: terminal?.zfsTty
    })
    registerProcessKernel(proc, this, options.shell)
    this.init.adopt(proc)

    try {
      const wasmBytes = await options.shell.context.fs.promises.readFile(options.command)
      const needsWasi = await this.wasm.detectWasiRequirements(wasmBytes)

      let stdin: ReadableStream<Uint8Array>
      let closeStdin: (() => void) | null = null

      if (options.stdin) {
        stdin = options.stdin
      } else if (terminal && shouldUnlisten) {
        const stdinWithClose = terminal.getInputStreamWithClose()
        stdin = stdinWithClose.stream
        closeStdin = stdinWithClose.close
      } else {
        stdin = terminal?.getInputStream() || new ReadableStream<Uint8Array>()
      }

      const stdout = options.stdout || terminal?.stdout || new WritableStream<Uint8Array>()
      const stderr = options.stderr || terminal?.stderr || new WritableStream<Uint8Array>()

      if (shouldUnlisten) {
        terminal.clearCommand()
        terminal.unlisten()

        keyListener = terminal.onKey(({ domEvent }) => {
          if (domEvent.ctrlKey && domEvent.key === 'c') {
            domEvent.preventDefault()
            domEvent.stopPropagation()
            // `proc` is signalable, but WASM without asyncify has no yield point and is not preempted; only code that
            // checks for signals, or the adapters watching `INTERRUPT`, reacts.
            proc.kill(ZenFSSignal.INT)
            terminal.events.dispatch(TerminalEvents.INTERRUPT, { terminal })
            return
          }

          if (domEvent.ctrlKey && domEvent.key === 'd') {
            domEvent.preventDefault()
            domEvent.stopPropagation()
            if (closeStdin) closeStdin()
            else stdin.cancel().catch(() => {})
            return
          }

          domEvent.preventDefault()
          domEvent.stopPropagation()

          // Echo to terminal and dispatch to stdin
          if (domEvent.key === 'Enter') {
            terminal.write('\r\n')
            // Send newline to stdin (fgets expects \n)
            terminal.dispatchStdin('\n')
          } else if (domEvent.key.length === 1) {
            terminal.write(domEvent.key)
            terminal.dispatchStdin(domEvent.key)
          }
        })
      }

      let exitCode = 0
      try {
        if (needsWasi) {
          const result = await this.wasm.loadWasiComponent(options.command, {
            stdin,
            stdout,
            stderr
          }, [options.command, ...(options.args || [])], options.shell || this.shell, proc.pid)
          exitCode = await result.exitCode
        } else {
          const { instance } = await this.wasm.loadWasm(options.command)
          const exports = instance.exports

          if (typeof exports._start === 'function') {
            try {
              (exports._start as () => void)()
              exitCode = 0
            } catch (error) {
              this.log.error(`WASM _start failed: ${(error as Error).message}`)
              exitCode = 1
            }
          } else if (typeof exports._initialize === 'function') {
            try {
              (exports._initialize as () => void)()
              exitCode = 0
            } catch (error) {
              this.log.error(`WASM _initialize failed: ${(error as Error).message}`)
              exitCode = 1
            }
          }
        }
      } finally {
        proc.exit(exitCode)
      }

      return exitCode
    } catch (error) {
      this.log.error(`Failed to execute WASM: ${error}`)
      terminal?.writeln(chalk.red((error as Error).message))
      if (!proc.zombie) proc.exit(-1)
      return -1
    } finally {
      if (keyListener) {
        keyListener.dispose()
      }
      if (shouldUnlisten) {
        terminal.listen()
      }
      // A stream it was handed (pipe, redirect) is closed so the far end sees EOF and a file redirect writes what it
      // holds; the terminal's shared streams are left open
      if (options.stdout && options.stdout !== terminal?.stdout) await options.stdout.close().catch(() => {})
      if (options.stderr && options.stderr !== terminal?.stderr) await options.stderr.close().catch(() => {})
    }
  }

  /**
   * Executes a script file
   * @param options - Execution options containing script path and shell
   * @returns Exit code of the script
   */
  async executeScript(options: KernelExecuteOptions): Promise<number> {
    const header = await this.readFileHeader(options.command, options.shell)
    if (!header) return -1

    if (header.type !== 'bin' || header.namespace !== 'script') {
      this.log.error(`File is not a script: ${options.command}`)
      return -1
    }

    return await this.runScriptFile(options)
  }

  /** Runs a text file as a shell script in `options.shell`, with `options.args` as `$1 $2 ...`. */
  private async runScriptFile(options: KernelExecuteOptions): Promise<number> {
    const script = await options.shell.context.fs.promises.readFile(options.command, 'utf-8')
    if (script) {
      const terminalCmdBefore = options.terminal?.cmd || ''

      // Multi-line control flow, functions and `set` options live in the statement tree `executeScriptText` walks.
      const exitCode = await options.shell.executeScriptText(script, options.invokedAs ?? options.command, options.args)

      if (options.terminal && terminalCmdBefore && options.terminal.cmd === terminalCmdBefore) {
        options.terminal.clearCommand()
        options.terminal.write(options.terminal.prompt())
      }

      return exitCode
    } else this.log.error(`Script ${options.command} not found`)

    return -1
  }

  /**
   * Shows a system notification if permissions are granted
   * @param {string} title - Notification title
   * @param {NotificationOptions} options - Notification options
   * @returns {Promise<Notification|void>} The created notification or void if permissions denied
   */
  async notify(title: string, options: NotificationOptions = {}): Promise<void | Notification> {
    return this.host.platform.notifications?.send(title, options)
  }

  /**
   * Removes an event listener from the kernel.
   * @param {KernelEvents} event - The event to remove the listener from.
   * @param {EventCallback} listener - The listener to remove.
   * @returns {void}
   */
  off(event: KernelEvents, listener: EventCallback): void {
    this.events.off(event, listener)
  }

  /**
   * Adds an event listener to the kernel.
   * @param {KernelEvents} event - The event to listen for.
   * @param {EventCallback} listener - The listener to add.
   * @returns {void}
   */
  on(event: KernelEvents, listener: EventCallback): void {
    this.events.on(event, listener)
  }

  /**
   * Reads and parses a file header to determine its type
   * @param {string} filePath - Path to the file
   * @param {IShell} shell - Optional shell instance to use for filesystem operations
   * @returns {Promise<FileHeader|null>} Parsed header information or null if invalid
   */
  async readFileHeader(filePath: string, shell?: IShell): Promise<FileHeader | null> {
    const parseHeader = (header: string): FileHeader | null => {
      if (!header.startsWith('#!')) return null
      if (header.startsWith('#!ecmaos:')) {
        const [type, namespace, name] = header.replace('#!ecmaos:', '').split(':')
        if (!type) return null
        return { type, namespace, name }
      }

      if (header.startsWith('#!/usr/bin/env node')) return { type: 'bin', namespace: 'node', name: 'node' }

      // Any other `#!` is an ordinary POSIX shebang naming a real interpreter. ecmaOS does not
      // parse it here: `@zenfs/linux`'s own `binfmt_script` already implements the real rule -
      // split `#!name [arg]`, rewrite argv to `[name, arg?, filename, ...rest]`, re-search the
      // binfmt table, with a chain-depth limit and `ENOEXEC` on a truncated line. Classifying it
      // as `interpreter` routes it to `executeViaExecve`, which hands the untouched path to
      // upstream `execve` and lets that handler do the work.
      //
      // Before this, such a file fell through to `checkExtensionType` and came back as
      // `application/octet-stream`, which `execute`'s switch has no case for - so a `#!/bin/sh`
      // script exited -1 with no diagnostic at all. An interpreter that does not exist now fails
      // as a real `ENOENT` from `execve` instead of silently.
      const interpreter = header.slice(2).trim().split(/[ \t]+/)[0]
      if (interpreter) return { type: 'bin', namespace: 'interpreter', name: interpreter }
      return null
    }

    const checkMagicBytes = (buffer: Uint8Array, magicBytes: Uint8Array, offset: number = 0): boolean => {
      if (buffer.length < offset + magicBytes.length) return false
      return magicBytes.every((byte, index) => byte === buffer[offset + index])
    }

    const checkMagicBytesPattern = (buffer: Uint8Array, pattern: { bytes: Uint8Array; type: string; offset?: number; checker?: (buf: Uint8Array) => boolean }): boolean => {
      if (pattern.checker) {
        return pattern.checker(buffer)
      }
      return checkMagicBytes(buffer, pattern.bytes, pattern.offset || 0)
    }

    const shellContext = shell?.context || this.shell.context

    try {
      if (!await shellContext.fs.promises.exists(filePath)) return null

      // A path under /dev backed by a device with a CLI is that device's command, not a file to
      // sniff: it is a character-device node, and reading its "first bytes" would invoke the
      // device's own read() handler rather than tell us anything about how to run it.
      if (filePath.startsWith('/dev/')) {
        const deviceName = filePath.replace(/^\/dev\//, '')
        const device = Array.from(this.devices.values())
          .find(d => d.device.pkg.name === deviceName || d.drivers?.some(driver => driver.name === deviceName))

        if (device?.device.cli) return { type: 'bin', namespace: 'device', name: device.device.pkg.name }
      }

      const magicBytesPatterns: Array<{ bytes: Uint8Array; type: string; offset?: number; checker?: (buf: Uint8Array) => boolean }> = [
        { bytes: new Uint8Array([0x00, 0x61, 0x73, 0x6D]), type: 'wasm' }, // WebAssembly Binary
        { bytes: new Uint8Array([0xFF, 0xD8, 0xFF]), type: 'view' }, // JPEG Image (Start of Image / SOI)
        { bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47]), type: 'view' }, // PNG Image (ASCII ".PNG")
        { bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38]), type: 'view' }, // GIF Image (ASCII "GIF8" - matches GIF87a and GIF89a)
        { bytes: new Uint8Array([0x47, 0x49, 0x46, 0x39]), type: 'view' }, // GIF Image (ASCII "GIF9" - likely a typo intended for GIF89a)
        { bytes: new Uint8Array([0x42, 0x4D]), type: 'view' }, // BMP Image (ASCII "BM" - Windows Bitmap)
        { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), type: 'view' }, // PDF Document (ASCII "%PDF")
        { bytes: new Uint8Array([0x66, 0x4C, 0x61, 0x43]), type: 'view' }, // FLAC Audio (ASCII "fLaC")
        { bytes: new Uint8Array([0x4F, 0x67, 0x67, 0x53]), type: 'view' }, // Ogg Container (ASCII "OggS" - Vorbis, Theora, etc.)
        { bytes: new Uint8Array([0xFF, 0xFB]), type: 'view' }, // MP3 Audio (MPEG-1 Layer 3, No CRC)
        { bytes: new Uint8Array([0xFF, 0xF3]), type: 'view' }, // MP3 Audio (MPEG-2 Layer 3, No CRC - Lower sampling rates)
        { bytes: new Uint8Array([0xFF, 0xF2]), type: 'view' }, // MP3 Audio (MPEG-2 Layer 3, CRC Protected)
        { bytes: new Uint8Array([0x49, 0x44, 0x33]), type: 'view' }, // MP3 Metadata (ID3v2 container - often at start of MP3)
        { bytes: new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]), type: 'view' }, // Matroska / WebM (EBML Header ID)
        {
          bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), // RIFF (ASCII "RIFF")
          type: 'view',
          checker: (buf: Uint8Array) => {
            if (buf.length < 12) return false
            if (!checkMagicBytes(buf, new Uint8Array([0x52, 0x49, 0x46, 0x46]))) return false
            const avi = new Uint8Array([0x41, 0x56, 0x49, 0x20]) // AVI Video (ASCII "AVI ")
            const webp = new Uint8Array([0x57, 0x45, 0x42, 0x50]) // WebP Image (ASCII "WEBP")
            const wave = new Uint8Array([0x57, 0x41, 0x56, 0x45]) // WAV Audio (ASCII "WAVE")
            return checkMagicBytes(buf, avi, 8) || checkMagicBytes(buf, webp, 8) || checkMagicBytes(buf, wave, 8)
          }
        },
        {
          bytes: new Uint8Array([0x00]), // MP4 Video (ASCII "MP4V")
          type: 'view',
          checker: (buf: Uint8Array) => {
            if (buf.length < 8) return false
            const ftyp = new Uint8Array([0x66, 0x74, 0x79, 0x70])
            return checkMagicBytes(buf, ftyp, 4)
          }
        }
      ]
      
      const maxMagicBytesLength = Math.max(12, ...magicBytesPatterns.map(p => (p.offset || 0) + p.bytes.length))
      
      let handle
      let firstBytes: Uint8Array | null = null

      // A link such as /usr/bin/env is classified by what it points at, so /bin/env's rule applies
      const linked = await shellContext.fs.promises.realpath(filePath).catch(() => filePath)

      const checkExtensionType = (path: string): FileHeader['type'] | null => {
        const filePath = path
        if (/\.[cm]?js$/.test(filePath)) return 'js'
        else if (filePath.endsWith('.md')) return 'view'
        else if (filePath.endsWith('.json')) return 'view'
        else if (filePath.endsWith('.txt')) return 'view'
        // A file under `/bin` or `/sbin` with no shebang and no magic bytes is bundled JS, run through `binfmt_js`.
        else if (filePath.startsWith('/bin/') || filePath.startsWith('/sbin/')) return 'js'
        else return 'application/octet-stream'
      }
      
      try {
        handle = await shellContext.fs.promises.open(filePath, 'r')
        const buffer = new Uint8Array(maxMagicBytesLength)
        const result = await handle.read(buffer, 0, maxMagicBytesLength, 0)
        if (result.bytesRead >= maxMagicBytesLength) firstBytes = buffer
      } catch {
        const readable = shellContext.fs.createReadStream(filePath)
        return new Promise<FileHeader | null>((resolve, reject) => {
          let firstChunk: Buffer | null = null
          
          readable.on('data', (chunk: Buffer) => {
            if (firstChunk === null) {
              firstChunk = chunk
              
              if (chunk.length >= maxMagicBytesLength) {
                const chunkBytes = new Uint8Array(chunk.buffer, chunk.byteOffset, maxMagicBytesLength)
                for (const pattern of magicBytesPatterns) {
                  if (checkMagicBytesPattern(chunkBytes, pattern)) {
                    readable.destroy()
                    return resolve({ type: pattern.type as FileHeader['type'] })
                  }
                }
              }
              
              const firstLine = chunk.toString().split('\n')[0] || ''
              const header = parseHeader(firstLine)
              if (header) {
                readable.destroy()
                return resolve(header)
              }

              readable.destroy()
              const extensionType = checkExtensionType(linked)
              return extensionType ? resolve({ type: extensionType }) : resolve(null)
            }
          })
          
          readable.on('error', (error: Error) => reject(error))
          readable.on('close', () => {
            readable.destroy()
            const extensionType = checkExtensionType(linked)
            return extensionType ? resolve({ type: extensionType }) : resolve(null)
          })
        })
      }
      
      if (!handle) return null
      
      if (firstBytes) {
        for (const pattern of magicBytesPatterns) {
          if (checkMagicBytesPattern(firstBytes, pattern)) {
            await handle.close()
            return { type: pattern.type as FileHeader['type'] }
          }
        }
      }
      
      const firstLineBuffer = new Uint8Array(512)
      const firstLineResult = await handle.read(firstLineBuffer, 0, 512, 0)
      await handle.close()
      
      if (firstLineResult.bytesRead > 0) {
        const firstLine = new TextDecoder().decode(firstLineBuffer.slice(0, firstLineResult.bytesRead)).split('\n')[0] || ''
        const header = parseHeader(firstLine)
        if (header) return header
      }
      
      const extensionType = checkExtensionType(linked)
      return extensionType ? { type: extensionType } : null
    } catch (error) {
      this.log.error(error)
      throw error
    }
  }

  /**
   * What init does last: `reboot` shuts down and reloads the page, `halt` only shuts down, `poweroff` shuts down and
   * then tries to close the page (best effort; browsers only close windows a script opened).
   */
  async stop(mode: 'reboot' | 'halt' | 'poweroff') {
    if (mode === 'reboot') return this.reboot()
    this.log.warn(mode === 'halt' ? 'System halted' : 'Power down')
    await this._logFile?.flush()
    await rootWritesSettled()
    await this.shutdown()
    if (mode === 'poweroff' && !this.host.platform.exit) {
      try { globalThis.close() } catch { /* not allowed to close this window */ }
    }
    await this.host.platform.exit?.(mode)
  }

  /**
   * Asks init to reboot, the way the `reboot` command does, so everything is stopped in order first.
   * Straight to {@link reboot} when init is not running, or when it has not taken the system down
   * within 15 seconds, so a wedged init cannot make the keyboard shortcut useless.
   */
  requestReboot() {
    const init = this.init.process
    if (!init || init.code !== undefined) { void this.reboot(); return }
    init.kill(ZenFSSignal.TERM)
    setTimeout(() => { if (this._state !== KernelState.SHUTDOWN) void this.reboot() }, 15_000)
  }

  /**
   * Reboots the kernel by performing a shutdown and page reload
   */
  async reboot() {
    this.log.warn(this.i18n.ns.common('Rebooting'))
    await this._logFile?.flush()
    await rootWritesSettled()
    await this.shutdown()
    await this.host.platform.restart()
  }

  /**
   * Where the catalog of prebuilt WebAssembly programs is. `KernelOptions.programs` overrides it (`false` turns it
   * off),
   * then `ECMAOS_PROGRAMS` (`none` turns it off); with neither set it is the catalog the site serves.
   */
  private programsUrl(): string {
    if (this.options.programs === false) return ''
    if (this.options.programs) return this.options.programs
    const configured = import.meta.env['ECMAOS_PROGRAMS'] as string | undefined
    if (configured === 'none') return ''
    return configured || '/programs/index.json'
  }

  /**
   * Registers the terminal commands.
   * @returns {Promise<void>} A promise that resolves when the terminal commands are registered.
   */
  async registerCommands() {
    if (!await this.filesystem.fs.exists('/bin')) await this.filesystem.fs.mkdir('/bin')

    // Real Linux has no equivalent of this method at all - `execve`+`$PATH` resolve a command
    // purely off real files on disk. This writes each command's actual file into `/bin` up front:
    // a name that runs via real `execve` gets its actual bundled program written here (no
    // registry/manifest lookup needed to run it, only to know it needs a file at all); a name still
    // on the in-process path gets the `#!ecmaos:bin:command:` stub `readFileHeader` recognizes to
    // route it through `executeCommand`'s shim. Building only names + this cheap check (not full
    // `TerminalCommand` construction) is what makes this cheap regardless of how many in-process
    // commands remain - `getLegacyCommands()` hands back `{ description, createCommand }` pairs,
    // but only `Object.keys(...)` is used here.
    //
    // True shell builtins (`cd`, `export`, ... - see `lib/shell-builtins.ts`) get NO `/bin/<name>`
    // file at all, matching real bash having no `/bin/cd` - `Shell.execute` dispatches them before
    // any file-based resolution is even attempted.
    const names = [
      ...Object.keys(migratedCommandSources),
      ...Object.keys(migratedKernelCommandSources),
      ...Object.keys(getLegacyCommands())
    ].filter(name => !this.options.blacklist?.commands?.includes(name))

    // Independent files, so several at a time: a boot writes about 170 of them, one after another otherwise
    const install = async (name: string) => {
      const target = `${SbinCommands.has(name) ? '/sbin' : '/bin'}/${name}`
      const source = migratedCommandSources[name] ?? migratedKernelCommandSources[name] ?? `#!ecmaos:bin:command:${name}`
      // The root persists across page loads, so an existing file is only kept if it already holds
      // exactly this build's program; otherwise an upgraded (or fixed) command would never reach
      // an existing install, which would keep running whatever version first created the file.
      if (await this.filesystem.fs.exists(target) && await this.filesystem.fs.readFile(target, 'utf8') === source) return
      await this.filesystem.fs.writeFile(target, source, { mode: 0o755 })
    }
    for (let i = 0; i < names.length; i += 16) await Promise.all(names.slice(i, i + 16).map(install))

    // Prebuilt WebAssembly programs (`vim`, `jq`, `make`, ...): real binaries, fetched from the site's program
    // catalog and written only when the installed copy differs. See `lib/programs.ts`. Boot waits for the catalog and
    // a placeholder for each program not installed yet; the downloads start once the kernel is running (they would
    // hold up the rest of boot's file system work), and a placeholder that is run waits for its program.
    const catalogUrl = this.programsUrl()
    if (catalogUrl) {
      const stampKey = this.machineKey('ecmaos:programs')
      await this.filesystem.fs.mkdir(path.dirname(PROGRAM_WAITER), { recursive: true })
      await this.filesystem.fs.writeFile(PROGRAM_WAITER, programWaiterSource, { mode: 0o755 })
      const staged = await stagePrograms(this.filesystem.fs, {
        placeholders: true,
        catalogUrl,
        fetcher: this.host.fetch,
        // A program's runtime (`vim`'s /usr/share/vim) is a tarball rooted at `/`
        extract: async tarball => {
          const file = '/tmp/runtime.tar'
          await this.filesystem.fs.writeFile(file, tarball)
          try { await this.filesystem.extractTarball(file, '/', 0o644, 0o755) } finally { await this.filesystem.fs.unlink(file).catch(() => {}) }
        },
        skip: name => !!this.options.blacklist?.commands?.includes(name),
        stamps: {
          read: () => { try { return JSON.parse(this.storage.local.getItem(stampKey) ?? '{}') } catch { return {} } },
          write: stamps => this.storage.local.setItem(stampKey, JSON.stringify(stamps))
        }
      })
      const started = new Promise<void>(resolve => { this._startPrograms = resolve })
      this._programsReady = started.then(() => staged.start()).then(programs => {
        if (programs.installed.length) this.log.info(`Installed programs: ${programs.installed.join(', ')}`)
        for (const [name, reason] of Object.entries(programs.failed)) this.log.warn(`Program ${name} was not installed: ${reason}`)
      })
      if (this._state === KernelState.RUNNING) this._startPrograms?.()
    }

    // The dev server's workspace apps (`startx`): `/bin/<name>` follows `apps/<app>/dist`, so a rebuilt app is current
    // after a reload. Absent in production and under test.
    if (import.meta.env['MODE'] === 'development') {
      const stampKey = this.machineKey('ecmaos:dev-apps')
      const apps = await installPrograms(this.filesystem.fs, {
        catalogUrl: '/dev-apps/index.json',
        fetcher: this.host.fetch,
        stamps: {
          read: () => { try { return JSON.parse(this.storage.local.getItem(stampKey) ?? '{}') } catch { return {} } },
          write: stamps => this.storage.local.setItem(stampKey, JSON.stringify(stamps))
        }
      })
      if (apps.installed.length) this.log.info(`Updated dev apps: ${apps.installed.join(', ')}`)
    }

    // A stub from a command that is not on the in-process path this build (it is a real program
    // under another name, or was dropped) can only fail when run; clear any, so a stub never
    // outlives the command it pointed at.
    const stubNames = new Set(names.filter(name => !migratedCommandSources[name] && !migratedKernelCommandSources[name]))
    await removeStaleCommandStubs(this.filesystem.fs, stubNames)

    // Names scripts expect to find: `#!/bin/sh`, `#!/bin/bash` and `#!/usr/bin/env ...`. The shell is
    // ecmash for both, so a script written for either runs on the shell that is here.
    for (const [link, target] of Object.entries(CommandLinks)) {
      if (!await this.filesystem.fs.exists(target)) continue
      // `vi` was once its own program (busybox); a file left by that build would hide the link.
      if (SupersededPrograms.has(link) && (await this.filesystem.fs.lstat(link).catch(() => undefined))?.isFile()) await this.filesystem.fs.unlink(link)
      await this.filesystem.fs.symlink(target, link).catch(() => {})
    }

    const setuid = await ensureSetuidPrograms(this.filesystem.fs).catch(error => { this.log.warn(`setuid programs: ${(error as Error).message}`); return [] as string[] })
    if (setuid.length) this.log.info(`Set the setuid bit on ${setuid.join(', ')}`)
  }

  /**
   * Registers the devices. `char_dev.register` claims a whole major for one `FileOperations`, so packages returning
   * several {@link KernelCharDevice}s under one major are registered once, with a dispatcher that routes by minor.
   */
  async registerDevices() {
    // Drivers from every package are collected first and grouped by major globally, since many drivers share one
    // major (misc 10) and a second registration of a major fails with EBUSY.
    const allDrivers: { device: (typeof DefaultDevices)[string]; driver: KernelCharDevice }[] = []

    for (const device of Object.values(this.options.devices || DefaultDevices)) {
      let drivers: KernelCharDevice[]
      try {
        drivers = await device.getDrivers(this.context)
      } catch (error) {
        this.log.warn(`device ${device.pkg.name} unavailable: ${(error as Error).message}`)
        continue
      }

      this.devices.set(device.pkg.name, { device, drivers })
      for (const driver of drivers) allDrivers.push({ device, driver })

      for (const tty of await device.getTTYDrivers?.(this.context).catch(error => {
        this.log.warn(`device ${device.pkg.name}: no terminals: ${(error as Error).message}`)
        return []
      }) ?? []) {
        // A second kernel in the same realm finds the numbers taken (EBUSY); the driver is the same one
        try { tty.register() } catch (error) {
          if ((error as { code?: string }).code !== 'EBUSY') this.log.warn(`terminal driver ${tty.name}: ${(error as Error).message}`)
        }
        registerHeldOperations(tty.major, tty.fops)
      }
    }

    // A driver that asks for major 0 wants a dynamic major of its own: every package that did would otherwise share
    // one
    // dynamic major, and the dispatch below is by minor alone, so two packages using the same minor would answer each
    // other's nodes.
    const byMajor = new Map<number | string, typeof allDrivers>()
    for (const entry of allDrivers) {
      const key = !entry.driver.major ? `dynamic:${entry.device.pkg.name}` : entry.driver.major
      const group = byMajor.get(key) ?? []
      group.push(entry)
      byMajor.set(key, group)
    }

    for (const [key, group] of byMajor) {
      const requestedMajor = typeof key === 'number' ? key : 0
      const dispatch = (file: Parameters<NonNullable<FileOperations['read']>>[0]) => {
        const entry = group.find(({ driver }) => driver.minor === file.devt.minor)
        if (!entry) {
          const made = dynamicMinor(file.devt.major, file.devt.minor)
          if (made) return made
          throw new Error(`No device registered at minor ${file.devt.minor}`)
        }

        // Manifest `devices` enforcement; see `lib/syscall-policy.ts`. `current` is the calling process. No manifest,
        // or no `devices` list, is unrestricted.
        const exe = zenfsCurrent?.exe
        if (exe) {
          const manifest = getCachedManifest(exe)
          const allowed = manifest?.devices
          if (allowed && !allowed.includes(entry.driver.name) && !allowed.includes(entry.driver.class?.name)) {
            throw withErrno('EPERM')
          }
        }

        return entry.driver.ops
      }

      const ops: FileOperations = {
        open: file => dispatch(file).open?.(file),
        release: file => dispatch(file).release?.(file),
        read: (file, buffer, start, end) => dispatch(file).read?.(file, buffer, start, end),
        write: (file, buffer, offset) => dispatch(file).write?.(file, buffer, offset),
        sync: file => dispatch(file).sync?.(file),
        poll: file => dispatch(file).poll?.(file) ?? 0,
        poll_wait: file => dispatch(file).poll_wait?.(file),
        // a request is answered by the driver of the node it is made on, a node made at runtime too; one no driver of this
        // major knows is left to the file system
        ioctl: group.some(({ driver }) => driver.ops.ioctl) ? new Proxy({}, {
          get: (_target, request) => group.some(({ driver }) => driver.ops.ioctl?.[request as never]) || dynamicIoctl(major, request)
            ? (context: never, file: Parameters<NonNullable<FileOperations['read']>>[0], ...args: unknown[]) => {
              const handler = dispatch(file).ioctl?.[request as never]
              if (!handler) throw withErrno('ENOTTY')
              return handler(context, file, ...args)
            }
            : undefined
        }) as FileOperations['ioctl'] : undefined
      }

      // Majors and names are process-global in `@zenfs/linux`, so a second kernel in the same realm gets EBUSY/EEXIST
      // for the same drivers; these are ignored.
      let major: number
      try {
        major = char_dev.register(requestedMajor, typeof key === 'number' ? `major-${key}` : `ecmaos-${key.slice('dynamic:'.length)}`, ops)
      } catch (error) {
        this.log.warn(`Device major ${key} already registered: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      registerHeldOperations(major, ops)

      // `Device.register()` links a device into `/sys/bus/<name>/devices` from its `bus` field alone, giving each
      // web-capability device a `/sys/devices` and `/sys/class` entry.
      for (const { driver } of group) {
        try {
          new Device({ name: driver.name, class: driver.class, dev_t: { major, minor: driver.minor }, bus: this._webCapabilityBus }).register()
        } catch (error) {
          this.log.warn(`Device node ${driver.name} already registered: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /**
   * `/sys/bus/webcapability`, the bus ecmaOS's own {@link KernelCharDevice}s register on. Created once per kernel.
   */
  private get _webCapabilityBus(): BusType {
    this.__webCapabilityBus ??= new BusType('webcapability')
    return this.__webCapabilityBus
  }

  private __webCapabilityBus?: BusType

  /**
   * Registers the kernel events.
   * @returns {Promise<void>} A promise that resolves when the events are registered.
   */
  async registerEvents() {
    for (const event of Object.values(KernelEvents)) {
      this.events.on(event, async (detail: unknown) => {
        switch (event) {
          case KernelEvents.PANIC:
            this.log.fatal('KernelPanic:', detail)
            
            if (this.telemetry.active) {
              const tracer = this.telemetry.getTracer('ecmaos.kernel', this.version)
              const panicSpan = tracer.startSpan('kernel.panic', {
                attributes: {
                  'kernel.id': this.id,
                  'kernel.state': this._state,
                  'kernel.version': this.version
                }
              })
              
              const panicDetail = detail as KernelPanicEvent
              if (panicDetail?.error) {
                panicSpan.recordException(panicDetail.error)
                panicSpan.setStatus({ code: 2, message: panicDetail.error.message })
                panicSpan.setAttribute('error.name', panicDetail.error.name)
                panicSpan.setAttribute('error.message', panicDetail.error.message)
                if (panicDetail.error.stack) {
                  panicSpan.setAttribute('error.stack', panicDetail.error.stack)
                }
              }
              
              panicSpan.end()
            }
            
            break
        }
      })
    }
  }

  /**
   * Registers the packages from /etc/packages that should be auto-loaded on boot.
   * @returns {Promise<void>} A promise that resolves when the packages are registered.
   */
  async registerPackages() {
    try {
      const packagesData = await this.filesystem.fs.readFile('/etc/packages', 'utf-8')
      const packages = packagesData.split('\n').filter(Boolean).filter(pkg => !pkg.startsWith('#'))
      for (const pkg of packages) {
        const spec = pkg.match(/(@[^/]+\/[^@]+|[^@]+)(?:@([^/]+))?/)
        const name = spec?.[1]
        if (!name || !await this.filesystem.fs.exists(`/usr/lib/${name}`)) continue
        const versions = await this.filesystem.fs.readdir(`/usr/lib/${name}`)
        const version = semver.maxSatisfying(versions, spec?.[2] || '*') || spec?.[2] || '*'
        const pkgData = await this.filesystem.fs.readFile(`/usr/lib/${name}/${version}/package.json`, 'utf-8')
        const pkgJson = JSON.parse(pkgData)
        const mainFile = this.getPackageMainExport(pkgJson)
        if (!mainFile) continue

        const filePath = `/usr/lib/${name}/${version}/${mainFile}`
        const fileContents = await this.filesystem.fs.readFile(filePath, 'utf-8')
        const blob = new Blob([fileContents], { type: 'text/javascript' })
        const url = URL.createObjectURL(blob)
        try {
          this.log.info(`Loading package ${name} v${version}`)
          const imports = await import(/* @vite-ignore */ url)
          this.packages.set(name, imports as Module)
        } catch (err) {
          this.log.error(`Failed to load package ${name} v${version}: ${err}`)
        } finally {
          URL.revokeObjectURL(url)
        }
      }
    } catch { /* best-effort cleanup */ }
  }

  /**
   * Discovers the built-in screensavers. An `import.meta.glob` resolved at build time relative to
   * this file, so it cannot move out of `Kernel` the way `startScreensaverDaemon` did.
   */
  registerScreensavers() {
    const screensavers = import.meta.glob('./lib/screensavers/*.ts', { eager: true })
    for (const [key, saver] of Object.entries(screensavers)) {
      this.screensavers.set(
        key.replace('./lib/screensavers/', '').replace('.ts', ''),
        saver as { default: (options: { terminal: ITerminal }) => Promise<void>, exit: () => Promise<void> }
      )
    }
  }

  /**
   * Starts the idle screensaver daemon: shows `localStorage['screensaver']` (default `matrix`) after
   * `localStorage['screensaver-timeout']` ms (default 60000) of inactivity. Started by `/boot/init` through
   * `screensaver-daemon`.
   * @returns a function that stops the daemon, or undefined if the screensaver is not registered
   */
  startScreensaverDaemon(): (() => void) | undefined {
    // Screensavers draw on the page; with no DOM (a Node host) there is nothing to show.
    if (!globalThis.document) return undefined
    const currentSaver = this.storage.local.getItem('screensaver') || 'matrix'
    const saver = this.screensavers.get(currentSaver)
    if (!saver) return undefined

    let idleTimer: Timer
    const resetIdleTime = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => saver.default({ terminal: this.terminal }), parseInt(this.storage.local.getItem('screensaver-timeout') ?? '60000'))
    }

    resetIdleTime()
    const events = ['mousemove', 'keydown', 'keyup', 'keypress', 'pointerdown']
    for (const event of events) globalThis.addEventListener(event, resetIdleTime)

    return () => {
      clearTimeout(idleTimer)
      for (const event of events) globalThis.removeEventListener(event, resetIdleTime)
    }
  }

  /**
   * Loads and processes fstab entries from /etc/fstab.
   * @returns {Promise<void>} A promise that resolves when fstab is processed.
   */
  async loadFstab(): Promise<void> {
    try {
      const fstabPath = '/etc/fstab'
      if (!await this.filesystem.fs.exists(fstabPath)) {
        return
      }

      const content = await this.filesystem.fs.readFile(fstabPath, 'utf-8')
      const entries = parseFstabFile(content)
      if (entries.length === 0) return
      this.log.info(`Processing ${entries.length} fstab entries...`)

      // Create dummy streams and terminal mock to avoid WritableStream locking issues during boot
      // These streams discard all output since we're mounting programmatically
      const createDummyStreams = () => {
        const stdout = new WritableStream<Uint8Array>({ write() {} })
        const stderr = new WritableStream<Uint8Array>({ write() {} })
        const stdin = new ReadableStream<Uint8Array>({ start() {} })
        
        const dummyTerminal = {
          stdin,
          stdout,
          stderr,
          getInputStream: () => stdin,
          write: () => {},
          writeln: () => {}
        } as unknown as ITerminal
        
        return { stdin, stdout, stderr, terminal: dummyTerminal }
      }

      for (const entry of entries) {
        try {
          {
            const target = path.resolve('/', entry.target)
            const source = entry.source || ''
            const type = entry.type
            const options = entry.options

            // Build mount command arguments
            const mountArgs: string[] = ['-t', type]
            
            if (options) {
              mountArgs.push('-o', options)
            }
            
            // Filesystem types that don't require a source
            const noSourceTypes = ['memory', 'singlebuffer', 'webstorage', 'webaccess', 'opfs', 'xml', 'dropbox', 'googledrive']
            
            // Add source only if provided AND filesystem type requires it
            if (source && !noSourceTypes.includes(type.toLowerCase())) {
              mountArgs.push(source)
            }
            
            // Add target
            mountArgs.push(target)

            // Create fresh streams and terminal mock for each mount to avoid locking issues
            const streams = createDummyStreams()
            
            // Execute mount command programmatically
            const exitCode = await this.execute({
              command: '/bin/mount',
              args: mountArgs,
              shell: this.system,
              terminal: streams.terminal,
              stdin: streams.stdin,
              stdout: streams.stdout,
              stderr: streams.stderr,
              stdinIsTTY: false,
              stdoutIsTTY: false
            })
            
            if (exitCode === 0) {
              this.log.info(`Mounted ${type} filesystem at ${target}`)
            } else {
              throw new Error(`mount command exited with code ${exitCode} while mounting ${type} filesystem at ${target}`)
            }
          }
        } catch (error) {
          this.log.warn(`Failed to mount filesystem ${entry.target} (type: ${entry.type}): ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      this.log.info(`Processed ${entries.length} fstab entry/entries`)
    } catch (error) {
      this.log.warn(`Failed to load fstab: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Replaces imports in a script with SWAPI URLs (import maps cannot be dynamic).
   * @param {string} contents - the script contents
   */
  async replaceImports(contents: string, packagePath: string): Promise<string> {
    const replacements: Record<string, string> = {}
    const importRegex = /from ['"]([^'"]+)['"]/g
    const imports = contents.match(importRegex) || []
    for (const match of imports) {
      const importPath = match.replace(/from ['"]|['"]/g, '')
      const exists = await this.filesystem.fs.exists(`/usr/lib/${path.join(packagePath, importPath)}`)
      if (exists) replacements[match] = `from "${location.protocol}//${location.host}/swapi/fs${path.join(packagePath, importPath)}"`
    }

    for (const [match, replacement] of Object.entries(replacements)) contents = contents.replace(match, replacement)

    // process requires
    if (!globalThis.requiremap) globalThis.requiremap = new Map()
    const requireRegex = /require\(['"]([^'"]+)['"]\)/g
    const requires = contents.matchAll(requireRegex) || []
    for (const match of requires) {
      const id = match[1]
      if (!id || !id.startsWith('.')) continue

      const resolvedPath = path.resolve(packagePath, id)
      const resolvedStat = await this.filesystem.fs.stat(resolvedPath)
      const finalPath = resolvedStat.isFile() ? resolvedPath : path.resolve(resolvedPath, 'index.js')
      const depContents = await this.filesystem.fs.readFile(finalPath, 'utf-8')
      const finalContents = await this.replaceImports(depContents, path.dirname(finalPath))

      let depUrl = id
      for (const key of globalThis.requiremap.keys()) {
        depUrl = key
        break
      }

      globalThis.requiremap.set(depUrl, {
        command: 'ecmaos:require',
        filePath: resolvedPath,
        binLink: '',
        argv: [...globalThis.process.argv],
        argv0: globalThis.process.argv0,
        code: finalContents
      })

      contents = contents.replace(id, depUrl)
    }

    return contents
  }

  /** Points the default IndexedDB root at this machine's store; any other root (an embedder's own) is left alone */
  private machineOptions<T extends { mounts?: Record<string, unknown> }>(options: T): T {
    return this.machine ? withRootStore(options, machineStore(this.machine)) : options
  }

  /** The new-machine suggestion for the notice: a name no existing store has */
  private async suggestMachine(): Promise<string> {
    try { return freshMachineName((await globalThis.indexedDB.databases()).flatMap(db => db.name ? [db.name] : [])) } catch { return 'machine-2' }
  }

  /**
   * One tab per machine: takes the Web Lock for the IndexedDB root before it is loaded, waits (with a notice and a
   * "use it here"
   * button) when another tab has it, and stops this tab if another one takes it later. No lock for hosts without Web
   * Locks, or a
   * root that is not the IndexedDB store.
   */
  private async claimMachine(store: string | undefined): Promise<boolean> {
    const locks = this.host.locks
    if (!locks || !store) return false
    let lock: MachineLock | 'guest'
    try {
      const suggestion = await this.suggestMachine()
      lock = await claimMachine(locks, store, {
        busy: (takeOver, guest) => showOverlay(`This machine${this.machine ? ` (${this.machine})` : ''} is running in another tab`, [
          'Running it in two tabs would overwrite one tab\'s files with the other\'s.',
          'It starts here by itself when the other tab closes or halts it. The other tab may also be inactive, or in another window.',
          'Or open a console on it here (this tab shows one of its terminals), run a separate machine of its own in a new tab, or try a guest session here (nothing in it is saved):'
        ], [
          { label: 'Use it here instead', run: takeOver },
          { label: 'Guest session', run: guest },
          { label: 'Open a console on it (tty)', field: '1', run: tty => {
            const number = Number.parseInt(tty, 10)
            if (!(number >= 0 && number <= 7)) return
            globalThis.location.href = displayAddress(globalThis.location.href, number)
          } },
          { label: 'Open a separate machine', field: suggestion, run: name => {
            const parsed = parseMachine(name)
            if (parsed.error || !parsed.machine) return
            globalThis.open(`${globalThis.location?.pathname ?? '/'}?machine=${parsed.machine}`, '_blank')
          } }
        ])
      })
    } catch (error) {
      this.log.warn(`Not guarding against a second tab: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    if (lock === 'guest') {
      // its own stamps: this machine installs itself from nothing on every boot, and must not see (or leave) the real
      // machine's
      this._guestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      this.sweepGuestKeys()
      globalThis.addEventListener?.('pagehide', () => this.dropGuestKeys())
      return true
    }
    this._machineLock = lock
    this._displays = new DisplayOwner(store, async tty => (tty >= 0 && tty <= 7 ? (await this.shellForTty(tty)).terminal : undefined), locks)
    void lock.evicted.then(() => this.machineTaken(locks, store))
    return false
  }

  /** Whether a display is attached to `tty` */
  hasDisplay(tty: number): boolean { return this._displays?.has(tty) ?? false }

  /**
   * Has a browser call done by the display the user is at on `tty`; `undefined` when none is attached (see
   * `lib/remote-display.ts`)
   */
  presentOnDisplay(tty: number, kind: string, params: Record<string, unknown>): RemoteCall | undefined {
    return this._displays?.present(tty, kind, params)
  }

  /** Whether this tab runs a guest session (a scratch machine in memory, nothing saved) */
  get guest(): boolean { return this._guestId !== undefined }

  /** A `localStorage` key that describes this tab's machine: the machine's own, or a guest session's throwaway one */
  private machineKey(key: string): string {
    return this._guestId ? `ecmaos:guest:${this._guestId}:${key}` : machineKey(this.machine, key)
  }

  private dropGuestKeys() {
    const prefix = `ecmaos:guest:${this._guestId}:`
    try {
      const local = this.storage.local
      for (let at = local.length - 1; at >= 0; at--) { const key = local.key(at); if (key?.startsWith(prefix)) local.removeItem(key) }
    } catch { /* storage is gone */ }
  }

  /** Keys of guest sessions whose tab never got to clean up (a crash), older than a day */
  private sweepGuestKeys() {
    try {
      const local = this.storage.local
      for (let at = local.length - 1; at >= 0; at--) {
        const key = local.key(at)
        const id = key && /^ecmaos:guest:([0-9a-z]+):/.exec(key)?.[1]
        if (id && id !== this._guestId && Date.now() - parseInt(id.slice(0, 8), 36) > 86_400_000) local.removeItem(key)
      }
    } catch { /* storage is gone */ }
  }

  /**
   * Reads `/etc/quota` and applies it (see `lib/quota.ts`); a bad line is reported and skipped. Returns the problems
   * found.
   */
  async loadQuotas(): Promise<string[]> {
    let text = ''
    try { if (await this.filesystem.fs.exists('/etc/quota')) text = await this.filesystem.fs.readFile('/etc/quota', 'utf-8') } catch { /* no quotas */ }
    const byName = new Map([...this.users.all.values()].map(user => [user.username, user.uid]))
    const { limits, errors } = parseQuotas(text, name => byName.get(name))
    for (const error of errors) this.log.warn(`/etc/quota: ${error}`)
    configureQuotas(limits, measureOwnedBytes)
    return errors
  }

  /** Another tab took this machine: stop writing before anything else, stop everything, and say so */
  private async machineTaken(locks: LockManager, store: string) {
    fenceRootStore()
    this._machineLock = undefined
    this._displays?.close()
    this._displays = undefined
    this.log.warn('This machine was taken by another tab')
    try { this.init.killAll(9) } catch { /* init was not running yet */ }
    await this.shutdown()
    showOverlay(`This machine${this.machine ? ` (${this.machine})` : ''} moved to another tab`, [
      'Another tab took it, so this one has stopped; nothing more is saved from here.',
      'Taking it back reloads this tab with what the other tab saved.'
    ], [{
      label: 'Take it back',
      run: () => { void stealMachineLock(locks, store).then(() => this.host.platform.restart()) }
    }])
  }

  /**
   * Shuts down the kernel.
   * @returns {Promise<void>} A promise that resolves when the kernel is shut down.
   */
  async shutdown() {
    this._displays?.close()
    this._displays = undefined
    this._machineLock?.release()
    this._machineLock = undefined
    this.terminal.unlisten()
    this.intervals.clearAll()
    this.channel.close()
    this._state = KernelState.SHUTDOWN
    this.events.dispatch<KernelShutdownEvent>(KernelEvents.SHUTDOWN, { data: {} })
  }

  /**
   * Updates the i18n language from the LANG environment variable if present
   * This allows users to override the system-wide locale with their LANG env var
   */
  private updateLocaleFromEnv(shell: Shell): void {
    const langEnv = shell.env.get('LANG')
    if (langEnv) {
      try {
        this.i18n.setLanguage(langEnv)
        this.log.debug(`Locale updated from LANG env var: ${langEnv} -> ${this.i18n.language}`)
      } catch (error) {
        this.log.warn(`Failed to update locale from LANG env var: ${(error as Error).message}`)
      }
    }
  }

  /**
   * Logs in a shell with user credentials
   * @param shell - Shell instance to log in
   * @param options - Login options including auto-login credentials
   */
  async loginShell(shell: Shell, options?: { autoLogin?: { username: string, password: string } }): Promise<void> {
    const terminal = shell.terminal

    if (options?.autoLogin) {
      const { user, cred } = await this.users.login(options.autoLogin.username, options.autoLogin.password)
      await this.startSession(shell, user, cred)
      return
    }

    if (import.meta.env['ECMAOS_APP_SHOW_DEFAULT_LOGIN'] === 'true') {
      terminal.writeln(chalk.yellow.bold(`⚠️  ${this.i18n.ns.kernel('defaultLogin')}: root / root\n`))
    }

    const holidayEmojis: Record<string, string> = {
      '01-01': '🎉 ',
      '02-14': '💝 ',
      '03-17': '☘️ ',
      '04-01': '🎭 ',
      '05-05': '🇲🇽',
      '06-19': '✊ ',
      '07-04': '🇺🇸',
      '10-31': '🎃 ',
      '11-11': '🪖 ',
      '11-24': '🦃 ',
      '12-25': '🎄 ',
      '12-31': '🎇 ',
    }

    const now = new Date()
    const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const holidayEmoji = holidayEmojis[monthDay] || '🗓️ '
    const formattedDate = Intl.DateTimeFormat(this.memory.config.get('locale') as string || 'en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(now)

    terminal.writeln(`${holidayEmoji} ${formattedDate}`)

    const issue = await this.filesystem.fs.exists('/etc/issue')
      ? await this.filesystem.fs.readFile('/etc/issue', 'utf-8')
      : null

    if (issue) terminal.writeln(issue)

    while (true) {
      try {
        const loc = globalThis.location
        const protocol = loc?.protocol || 'ecmaos:'
        const hostname = loc?.hostname || 'localhost'
        const port = loc && loc.port && loc.port !== '80' && loc.port !== '443' ? `:${loc.port}` : ''

        const isSecure = globalThis.window?.isSecureContext ?? false
        const protocolStr = isSecure
          ? chalk.green(protocol)
          : chalk.red(protocol)
        const icon = isSecure ? '🔒' : '🔓'

        terminal.writeln(`${icon}  ${protocolStr}//${hostname}${port}`)

        const username = await terminal.readline(`👤  ${this.i18n.ns.common('Username')}: `)
        let userCred = await this.tryPasskeyLogin(terminal, username)
        const loginSuccess = userCred !== null

        if (!loginSuccess) {
          const password = await terminal.readline(`🔑  ${this.i18n.ns.common('Password')}: `, true)
          userCred = await this.users.login(username, password)
        }

        if (!userCred) throw new Error(this.i18n.ns.kernel('loginFailed'))

        await this.startSession(shell, userCred.user, userCred.cred)
        break
      } catch (err) {
        console.error(err)
        terminal.writeln(chalk.red((err as Error).message) + '\n')
      }
    }
  }

  /**
   * The passkey half of a login: when `username` has passkeys and the browser supports them, asks for
   * one and returns the session it yields. Null means "ask for a password" (no such user, no passkey,
   * or the attempt was cancelled or failed, which is said on `terminal`).
   */
  async tryPasskeyLogin(terminal: { writeln(text: string): void }, username: string): Promise<{ user: User, cred: Credentials } | null> {
    const t = this.i18n.i18next.getFixedT(this.i18n.language, 'kernel')
    const user = Array.from(this.users.all.values()).find(u => u.username === username)
    if (!user) return null
    const passkeys = await this.users.getPasskeys(user.uid)
    if (passkeys.length === 0 || !this.auth.passkey.isSupported()) return null

    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32))
      const rpId = globalThis.location.hostname || 'localhost'

      const allowCredentials = passkeys.map(pk => {
        const credentialIdBytes = Uint8Array.from(atob(pk.credentialId), c => c.charCodeAt(0))
        return {
          id: credentialIdBytes.buffer,
          type: 'public-key' as const,
          transports: ['usb', 'nfc', 'ble', 'internal'] as AuthenticatorTransport[]
        }
      })

      const requestOptions: PublicKeyCredentialRequestOptions = {
        challenge,
        allowCredentials,
        rpId,
        userVerification: 'preferred',
        timeout: 60000
      }

      terminal.writeln(chalk.yellow(`🔐  ${this.i18n.ns.kernel('passkeyAuthenticate')}`))
      const credential = await this.auth.passkey.get(requestOptions)

      if (credential && credential instanceof PublicKeyCredential) return await this.users.login(username, undefined, credential)
      terminal.writeln(chalk.yellow(t('kernel.passkeyCancelled', 'Passkey authentication cancelled or failed. Falling back to password...')))
    } catch (err) {
      terminal.writeln(chalk.yellow(t('kernel.passkeyError', 'Passkey authentication error: {{error}}. Falling back to password...', { error: (err as Error).message })))
    }
    return null
  }

  /**
   * A fresh context for `shell` under `cred`; the one it held is released, so each login does not leave a `[kernel]`
   * row in `/proc`.
   */
  private rebindShell(shell: Shell, cred: Credentials): void {
    const previous = shell.context
    shell.context = bindContext({ root: '/', pwd: '/', credentials: cred })
    // 1 is the default context, which belongs to the kernel itself
    if (previous && previous.id !== 1 && previous !== shell.context) boundContexts.delete(previous.id)
  }

  /**
   * Makes `user` the login on `shell`: credentials, bound context, identity variables, the session
   * record, the home directory, then the startup files in order. The one place a login takes effect,
   * shared by the built-in login prompt, auto-login, and `/sbin/getty` through `login_session`.
   */
  async startSession(shell: Shell, user: User, cred: Credentials): Promise<void> {
    shell.credentials = cred
    this.rebindShell(shell, cred)
    shell.env.set('UID', user.uid.toString())
    shell.env.set('GID', user.gid.toString())
    shell.env.set('SUID', cred.suid.toString())
    shell.env.set('SGID', cred.sgid.toString())
    shell.env.set('EUID', cred.euid.toString())
    shell.env.set('EGID', cred.egid.toString())
    shell.env.set('SHELL', user.shell || 'ecmaos')
    shell.env.set('HOME', user.home || '/root')
    shell.env.set('USER', user.username)
    shell.publishEnv()
    await shell.recordLogin(user.username)

    // A login shell starts in `$HOME`, set before the startup files so a `cd` in `~/.ecmashrc` wins.
    shell.cwd = shell.env.get('HOME') || '/'

    // Runs after `HOME` is set, since `~/.env` and `~/.ecmashrc` are read from `$HOME`.
    await shell.loadEnvFile()
    await shell.loadProfile()
    await shell.loadConfig()

    this.updateLocaleFromEnv(shell)
  }

  /** The shell whose own process is `pid` (what `$$` names), if any. */
  shellOfPid(pid: number): Shell | undefined {
    for (const shell of this._shells.values()) if (shell.ownsPid(pid)) return shell
    return undefined
  }

  /**
   * Terminals whose login is a `/sbin/getty` entry in /etc/inittab, decided at boot; the kernel does not prompt on
   * these.
   */
  private _gettyTtys = new Set<number>()

  private readonly _ready = (() => {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  })()

  /** Resolves when boot has finished, including the first-boot prompts a login prompt must not interleave with. */
  whenReady(): Promise<void> { return this._ready.promise }

  /** True once `whenReady` has resolved. */
  get ready(): boolean { return this._isReady }
  private _isReady = false

  /**
   * Resolves when the catalog's programs are installed (or have failed), which boot does not wait for. Until then a
   * program not installed before is a placeholder that waits for it.
   */
  whenProgramsReady(): Promise<void> { return this._programsReady }
  private _programsReady: Promise<void> = Promise.resolve()
  private _startPrograms?: () => void

  /** Each getty terminal's shell state from before its first login. */
  private readonly _cleanShells = new Map<number, ReturnType<Shell['state']['snapshot']>>()

  /**
   * Logins started by `beginLogin` that already succeeded by passkey, until `finishLogin` or `endLogin` takes them.
   */
  private readonly _pendingLogins = new Map<number, { username: string, session: { user: User, cred: Credentials } }>()

  /** The shell on `ttyNumber`, created (with its terminal) if it does not exist yet. */
  async shellForTty(ttyNumber: number): Promise<Shell> {
    return this._shells.get(ttyNumber) ?? await this.createShell(ttyNumber)
  }

  /**
   * First half of a login on `ttyNumber` for `/sbin/getty`: tries a passkey. True when `username` is
   * already authenticated and no password is needed.
   */
  async beginLogin(ttyNumber: number, username: string): Promise<boolean> {
    const shell = await this.shellForTty(ttyNumber)
    // The shell as it is before anyone has logged in on it; endLogin puts it back
    if (!this._cleanShells.has(ttyNumber)) this._cleanShells.set(ttyNumber, shell.state.snapshot())
    this._pendingLogins.delete(ttyNumber)
    const session = await this.tryPasskeyLogin(shell.terminal, username)
    if (!session) return false
    this._pendingLogins.set(ttyNumber, { username, session })
    return true
  }

  /**
   * Second half: authenticates (the passkey from `beginLogin`, or `password`) and starts the session on
   * the tty's shell. Resolves to what getty needs to run the user's shell; rejects with the message to show.
   */
  async finishLogin(ttyNumber: number, username: string, password: string): Promise<{ shell: string, home: string, username: string, uid: number, gid: number, groups: number[], env: Record<string, string> }> {
    const shell = await this.shellForTty(ttyNumber)
    const pending = this._pendingLogins.get(ttyNumber)
    this._pendingLogins.delete(ttyNumber)
    const session = pending?.username === username ? pending.session : await this.users.login(username, password)
    await this.startSession(shell, session.user, session.cred)
    return { shell: session.user.shell || 'ecmaos', home: session.user.home || '/root', username: session.user.username, uid: session.user.uid, gid: session.user.gid, groups: session.user.groups ?? [], env: shell.envObject }
  }

  /** A login on `ttyNumber` has ended: the session record goes, and the shell holds no user until the next login. */
  async endLogin(ttyNumber: number): Promise<void> {
    this._pendingLogins.delete(ttyNumber)
    const shell = this._shells.get(ttyNumber)
    await shell?.recordLogout()
    if (!shell) return

    // Nobody is logged in on this terminal now, so the shell must not keep anything of the last user:
    // credentials, variables, aliases, functions, traps and options go back to what the shell had
    // before the first login (root's credentials, as at boot).
    const clean = this._cleanShells.get(ttyNumber)
    if (clean) shell.state.restoreCopy(clean)
    const idle: Credentials = { uid: 0, gid: 0, suid: 0, sgid: 0, euid: 0, egid: 0, groups: [] }
    shell.credentials = idle
    this.rebindShell(shell, idle)
    for (const key of ['UID', 'GID', 'SUID', 'SGID', 'EUID', 'EGID']) shell.env.set(key, '0')
    shell.env.set('USER', 'root')
    shell.env.set('HOME', '/root')
    shell.cwd = '/'
    shell.publishEnv()
  }

  /**
   * Gets a shell by TTY number
   * @param ttyNumber - TTY number (0-7)
   * @returns Shell instance or undefined if not found
   */
  getShell(ttyNumber: number): Shell | undefined {
    return this._shells.get(ttyNumber)
  }

  /**
   * Creates a new shell and terminal for a TTY
   * @param ttyNumber - TTY number (0-7)
   * @returns Created shell instance
   */
  async createShell(ttyNumber: number): Promise<Shell> {
    if (ttyNumber < 0 || ttyNumber > 7) {
      throw new Error('TTY number must be between 0 and 7')
    }

    if (this._shells.has(ttyNumber)) {
      return this._shells.get(ttyNumber)!
    }

    const terminalContainer = document.getElementById(`terminal-tty${ttyNumber}`)
    if (!terminalContainer) {
      throw new Error(`Terminal container for TTY ${ttyNumber} not found`)
    }

    const wasActive = terminalContainer.classList.contains('active')
    if (!wasActive) {
      terminalContainer.classList.add('active')
    }

    const terminal = new Terminal({
      context: this.context,
      dom: this.dom,
      kernel: this,
      users: this.users,
      tty: ttyNumber
    })
    terminal.wire({
      switchTty: (tty: number) => this.switchTty(tty),
      reboot: () => this.requestReboot(),
      getState: () => this.state
    })
    terminal.mount(terminalContainer as HTMLElement)

    if (!wasActive && ttyNumber !== this._activeTty) {
      terminalContainer.classList.remove('active')
    }

    const shell = new Shell({
      context: this.context,
      createPipeStream: () => this.createPipeStream(),
      execute: options => this.execute({ ...options, kernel: this }),
      adoptProcess: process => this.init.adopt(process as InstanceType<typeof ZenFSProcess>),
      filesystem: this.filesystem,
      users: this.users,
      tty: ttyNumber,
      terminal,
      env: { KERNEL_NAME: this.name, KERNEL_VERSION: this.version, HOSTNAME: 'localhost' }
    })
    terminal.attachShell(shell)

    this._shells.set(ttyNumber, shell)

    // A getty on this terminal logs the user in, not the kernel. With the default inittab that is every
    // terminal, so TTYs 1 to 7 are no different from TTY 0.
    if (this._gettyTtys.has(ttyNumber)) return shell

    const autoLogin = this.options.credentials
      ? { username: this.options.credentials.username, password: this.options.credentials.password }
      : undefined

    await this.loginShell(shell, autoLogin ? { autoLogin } : undefined)

    const user = this.users.get(shell.credentials.uid ?? 0)
    if (!user) throw new Error(this.i18n.i18next.getFixedT(this.i18n.language, 'kernel')('kernel.userNotFound', 'User not found'))

    shell.credentials = {
      uid: user.uid,
      gid: user.gid,
      suid: user.uid,
      sgid: user.gid,
      euid: user.uid,
      egid: user.gid,
      groups: user.groups
    }

    const motd = await this.filesystem.fs.exists('/etc/motd')
      ? await this.filesystem.fs.readFile('/etc/motd', 'utf-8')
      : null

    if (motd) terminal.writeln('\n' + motd)

    terminal.focus()
    await this.enterLoginShell(shell)
    terminal.write(ansi.erase.inLine(2) + terminal.prompt())

    return shell
  }

  /**
   * Opens a login on a terminal with no page, for a user already authenticated (by key, over a peer link). Takes the
   * lowest free TTY of 1 to 7, starts the session and runs the built-in shell until `exit`. Output goes to
   * `options.write`; the caller feeds input to `session.terminal`.
   * @throws if every TTY is taken or the user may not log in
   */
  async openSession(options: { username: string, cols?: number, rows?: number, write: (data: string | Uint8Array) => void, onEnd?: () => void }): Promise<KernelSession> {
    const { user, cred } = await this.users.sessionFor(options.username)
    let tty = 1
    while (tty <= 7 && this._shells.has(tty)) tty++
    if (tty > 7) throw new Error('No free terminal: all of TTY 1 to 7 are in use')

    const terminal = new Terminal({ context: this.context, dom: this.dom, kernel: this, users: this.users, tty })
    terminal.wire({ switchTty: () => Promise.resolve(), reboot: () => this.requestReboot(), getState: () => this.state })
    const shell = new Shell({
      context: this.context,
      createPipeStream: () => this.createPipeStream(),
      execute: execution => this.execute({ ...execution, kernel: this }),
      adoptProcess: process => this.init.adopt(process as InstanceType<typeof ZenFSProcess>),
      filesystem: this.filesystem,
      users: this.users,
      tty,
      terminal,
      env: { KERNEL_NAME: this.name, KERNEL_VERSION: this.version, HOSTNAME: 'localhost' }
    })
    terminal.attachShell(shell)
    terminal.attachHeadless(options.write)
    if (options.cols && options.rows) terminal.resize(options.cols, options.rows)
    this._shells.set(tty, shell)

    let ended = false
    const end = async () => {
      if (ended) return
      ended = true
      // What a hangup does: whatever is running on the terminal is told its terminal went away
      try { terminal.zfsTty?.signal(ZenFSSignal.HUP) } catch { /* nothing was running */ }
      await shell.recordLogout()
      this._shells.delete(tty)
      terminal.dispose()
      options.onEnd?.()
    }

    try {
      await this.startSession(shell, user, cred)
      const motd = await this.filesystem.fs.exists('/etc/motd') ? await this.filesystem.fs.readFile('/etc/motd', 'utf-8') : null
      if (motd) terminal.writeln(motd)
      void (async () => {
        await this.enterLoginShell(shell)
        // A login shell that is the program has run and returned; one that is the built-in shell is the terminal's
        // own line editor
        if (shell.env.get('SHELL') !== '/bin/ecmash') await terminal.runSession()
        await end()
      })().catch(() => end())
    } catch (error) {
      await end()
      throw error
    }
    return { tty, shell, terminal, close: end }
  }

  /** A window with a terminal emulator running a program (a login shell by default) on a pty; see `openTerminalWindow`. */
  openTerminalWindow(options: TerminalWindowOptions): Promise<TerminalWindow> {
    return openTerminalWindow(this, options)
  }

  /** Runs a program as a user on a pty nothing watches; see `runDetached`. */
  runDetached(options: DetachedOptions): Promise<number> {
    return runDetached(this, options)
  }

  /**
   * Runs `command` as `username` with a pty slave for its terminal: standard input, output and error, the controlling
   * terminal and the foreground process group all belong to the slave. The caller holds the master (`createPty`) and
   * feeds an emulator from it. The process is a child of init, and closing the master hangs it up.
   * Programs started from it find no `Shell`, so they take their identity from their own credentials.
   */
  /** The environment a login session starts with: the system's, the user's identity and home, and a terminal type */
  private sessionEnvironment(user: User, cred: Credentials, cwd: string): Record<string, string> {
    return {
      ...this.system.envObject,
      UID: String(user.uid), GID: String(user.gid), EUID: String(cred.euid), EGID: String(cred.egid),
      HOME: user.home || '/root', USER: user.username, LOGNAME: user.username, SHELL: user.shell || '/bin/ecmash',
      TERM: 'xterm-256color', PWD: cwd
    }
  }

  /**
   * A login on a pty, for `/bin/login -p`: authenticates and resolves to what the login needs to start the user's shell on
   * the terminal it already has. There is no `Shell` behind a pty, so no session record and no startup files here; the
   * login shell reads its own.
   */
  async ptyLogin(username: string, password: string): Promise<{ shell: string, home: string, username: string, uid: number, gid: number, groups: number[], env: Record<string, string> }> {
    const { user, cred } = await this.users.login(username, password)
    const home = user.home || '/root'
    return { shell: user.shell || 'ecmaos', home, username: user.username, uid: user.uid, gid: user.gid, groups: user.groups ?? [], env: this.sessionEnvironment(user, cred, home) }
  }

  async spawnOnPty(options: { username: string, pty: KernelPty, command: string, args?: string[], env?: Record<string, string>, cwd?: string }): Promise<InstanceType<typeof ZenFSProcess>> {
    const { user, cred } = await this.users.sessionFor(options.username)
    const home = user.home || '/root'
    const cwd = options.cwd ?? home
    const env = { ...this.sessionEnvironment(user, cred, cwd), ...options.env }
    const init: Parameters<typeof bindContext>[0] & { umask?: number } = { root: '/', pwd: cwd, umask: 0 }
    if (this._programsRunAsUser && cred.euid !== 0) init.credentials = credentialsFor(cred)

    const proc = new ZenFSProcess({
      argv: [options.command, ...(options.args ?? [])],
      env,
      cwd,
      context: bindContext(init),
      tty: options.pty.slave,
      console: options.pty.path
    })
    this.init.adopt(proc)
    setUmask(proc, DEFAULT_UMASK)
    registerProcessKernel(proc, this)
    startSession(proc, options.pty.slave)
    await zenfsExecve(proc, options.command, [options.command, ...(options.args ?? [])], env)
    return proc
  }

  /**
   * Runs the user's login shell when it is `/bin/ecmash`; leaving it lands at the built-in shell. The built-in
   * `ecmaos` shell has no file to run.
   */
  private async enterLoginShell(shell: IShell): Promise<void> {
    if (shell.env.get('SHELL') !== '/bin/ecmash') return
    if (!await this.filesystem.fs.exists('/bin/ecmash')) return
    await shell.execute('ecmash -l')
  }

  /**
   * Switches to a different TTY
   * @param ttyNumber - TTY number to switch to (0-7)
   */
  async switchTty(ttyNumber: number): Promise<void> {
    if (ttyNumber < 0 || ttyNumber > 7) throw new Error('TTY number must be between 0 and 7')
    if (ttyNumber === this._activeTty) return

    const previousTty = this._activeTty
    this._activeTty = ttyNumber

    const currentShell = this._shells.get(previousTty)
    if (currentShell) {
      currentShell.terminal.unlisten()
      const currentContainer = document.getElementById(`terminal-tty${previousTty}`)
      if (currentContainer) currentContainer.classList.remove('active')
    }

    const targetContainer = document.getElementById(`terminal-tty${ttyNumber}`)
    if (targetContainer) targetContainer.classList.add('active')

    this.dom.showTtyIndicator(ttyNumber)

    let targetShell = this._shells.get(ttyNumber)
    if (!targetShell) targetShell = await this.createShell(ttyNumber)

    // The `globalThis.process.env` mirror follows the active console. Without this every shell wrote
    // to that one global object and the last one to log in decided what `$PATH` every other one saw.
    targetShell.claimProcessEnv()

    requestAnimationFrame(() => {
      if (targetShell.terminal.addons?.get('fit')) (targetShell.terminal.addons.get('fit') as FitAddon).fit()
      targetShell.terminal.focus()
      targetShell.terminal.listen()
    })
  }

  /**
   * Runs a `#!ecmaos:bin:script:` file for `/sbin/init` in the system shell (root's), the way boot has always run
   * `/boot/init`. Returns the script's status, or 1 when it could not run.
   */
  async runInitScript(path: string, args: string[] = []): Promise<number> {
    try {
      return await this.execute({ command: path, args, shell: this.system })
    } catch (error) {
      this.log.error(error)
      return 1
    }
  }

  /**
   * Sets up global debug utilities for browser console access.
   * Access via: ecmaos.kernel, ecmaos.processes(), etc.
   */
  private setupDebugGlobals() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ecmaos = (globalThis as any).ecmaos || {}
    
    Object.assign(ecmaos, {
      // Core references
      kernel: this,
      
      // Process utilities: the real `@zenfs/linux` process table
      processes: () => {
        const procs = Array.from(zenfsProcesses.values())
        console.table(procs.map(p => ({
          pid: p.pid,
          command: p.comm,
          status: p.code !== undefined ? 'exited' : p.stopped ? 'stopped' : 'running',
          cwd: p.cwd
        })))
        return procs
      },

      // Terminal reference
      terminal: this.terminal,
      
      // Shell reference
      shell: this.shell,
      
      // Filesystem reference
      fs: this.filesystem.fs
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).ecmaos = ecmaos
    
    this.log.debug('Debug globals available: ecmaos.kernel, ecmaos.processes(), ecmaos.terminal, ecmaos.shell, ecmaos.fs')
  }
}
