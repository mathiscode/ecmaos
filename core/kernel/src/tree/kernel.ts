/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * The Kernel class is the core of the ecmaOS system.
 * It manages the system's resources and provides a framework for system services.
 *
 */

import ansi from 'ansi-escape-sequences'
import chalk from 'chalk'
import figlet from 'figlet'
import Module from 'node:module'
import path from 'node:path'
import semver from 'semver'

import { bindContext, Credentials } from '@zenfs/core'
import { char_dev, console_driver, Device, execve as zenfsExecve, Module as ZenFSModule, Process as ZenFSProcess, Signal as ZenFSSignal, xterm_driver } from '@zenfs/linux'
import { char_dev_init as initMemDevices } from '@zenfs/linux/drivers/char/mem'
import { create_pipe, pipefs } from '@zenfs/linux/fs/pipe'
import type { FileOperations } from '@zenfs/linux'
// import { Emscripten } from '@zenfs/emscripten'
import { JSONSchemaForNPMPackageJsonFiles } from '@schemastore/package'
import { WebContainer } from '@webcontainer/api'
import { context, trace } from '@opentelemetry/api'

import './../themes/default.scss'

import { Auth } from '#auth.ts'
import { Components } from '#components.ts'
import { DefaultDevices } from '#device.ts'
import { DefaultDomOptions, Dom } from '#dom.ts'
import { DefaultFilesystemOptions, Filesystem } from '#filesystem.ts'
import { DefaultLogOptions, Log } from '#log.ts'
import { Terminal } from '#terminal.ts'
import { Events } from '#events.ts'
import { I18n } from '#i18n.ts'
import { Intervals } from '#intervals.ts'
import { Memory } from '#memory.ts'
import { Process, ProcessManager } from '#processes.ts'
import { Protocol } from '#protocol.ts'
import { DefaultServiceOptions, Service } from '#service.ts'
import { Sockets } from '#sockets.ts'
import { Shell } from '#shell.ts'
import { Storage } from '#storage.ts'
import { FitAddon } from '@xterm/addon-fit'
import { Telemetry } from '#telemetry.ts'
import { Users } from '#users.ts'
import { Wasm } from '#wasm.ts'
import { Windows } from '#windows.ts'
import { Workers } from '#workers.ts'

// import createBIOS, { BIOSModule } from '@ecmaos/bios'
import { getKernelLegacyCommands } from '#lib/commands/index.js'
import { getLegacyCommands, resolveLegacyCommand } from '@ecmaos/coreutils'
import { parseFstabFile } from '#lib/fstab.ts'
import { installSyscallPolicy } from '#lib/syscall-policy.ts'
import { installMainThreadSyscalls, registerProcessKernel } from '#lib/main-thread-syscalls.ts'
import migratedCommandSources from 'virtual:bin-commands'
import migratedKernelCommandSources from 'virtual:bin-kernel-commands'

import {
  KernelEvents,
  KernelState,
  TerminalEvents
} from '@ecmaos/types'

import type {
  BootOptions,
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
  Workers as IWorkers,
  EventCallback,
  ProcessEntryParams,
  FileHeader,
  KernelShutdownEvent,
  KernelModule,
  KernelModules,
  Timer
} from '@ecmaos/types'

const DefaultKernelOptions: KernelOptions = {
  devices: DefaultDevices,
  dom: DefaultDomOptions,
  log: DefaultLogOptions,
  filesystem: DefaultFilesystemOptions,
  service: DefaultServiceOptions
}

const DefaultBootOptions: BootOptions = { silent: false }
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
export class Kernel implements IKernel {
  /** Unique identifier for this kernel instance */
  public readonly id: string = crypto.randomUUID()
  /** Name of the kernel */
  public readonly name: string = import.meta.env['NAME'] || 'ecmaOS'
  /** Version string of the kernel */
  public readonly version: string = import.meta.env['VERSION'] || '?.?.?'

  /** Authentication and authorization service */
  public readonly auth: Auth
  /** BIOS module providing low-level functionality */
  // public bios?: BIOSModule
  /** Broadcast channel for inter-kernel communication */
  public readonly channel: BroadcastChannel
  /** Web Components manager */
  public readonly components: Components
  /** WebContainer instance */
  public container?: WebContainer
  /** DOM manipulation service */
  public readonly dom: Dom
  /** Map of registered devices and their drivers */
  public readonly devices: Map<string, { device: KernelDevice, drivers?: KernelCharDevice[] }> = new Map()
  /**
   * A dedicated, kernel-lifetime, never-`execve`'d `@zenfs/linux` `Process` the real pipes
   * `bridgeStdio` creates live in -- deliberately not a bare `bindContext()` `FSContext` (tried
   * first; doesn't work) and not any given `Process`'s own context (`Process.exit()` tears that
   * down on its own timing, which would race the pump loop reading the other end).
   *
   * It has to be a real, registered `Process` specifically because `fs/pipe.ts`'s own `write`
   * throws `EPIPE` unless its `open_ends()` check finds the *other* end of the pipe referenced by
   * some `Process` in `@zenfs/linux`'s module-level `processes` map -- a bare `FSContext` (even one
   * whose descriptors genuinely hold the fd) is invisible to that check, confirmed by hand against
   * the published package before settling on this. This process is never `execve`'d and never
   * exits; it exists purely as a real fd-table anchor.
   *
   * Created lazily since most execution never redirects `execve`'d stdio at all.
   */
  private _pipeProcess?: InstanceType<typeof ZenFSProcess>
  private get pipeProcess(): InstanceType<typeof ZenFSProcess> {
    this._pipeProcess ??= new ZenFSProcess({ console: '/dev/null' })
    return this._pipeProcess
  }

  /** Event management system */
  public readonly events: Events
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
  /** Process management service */
  public readonly processes: ProcessManager
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
    this.options = { ...DefaultKernelOptions, ..._options }

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
    this.processes = new ProcessManager()
    this.screensavers = new Map()
    this.windows = new Windows()
    this.workers = new Workers()

    // Tier 1: context-only.
    this.dom = new Dom(this.options.dom)
    this.sockets = new Sockets({ context: this.context })
    this.storage = new Storage({ context: this.context })
    this.telemetry = new Telemetry({ context: this.context })

    // Tier 2: context plus narrow, already-constructed dependencies (no cycles).
    this.filesystem = new Filesystem(this.storage)
    this.users = new Users({
      context: this.context,
      filesystem: this.filesystem,
      getShellCredentials: () => this.shell.credentials
    })

    // Tier 3: the Shell/Terminal cycle. `Shell` tolerates a not-yet-real `terminal` (as it always
    // has -- `attach()` below fixes it up), and `execute` is Kernel's own method, bound so Shell
    // never needs a `Kernel` reference of its own.
    this.shell = new Shell({
      context: this.context,
      createPipeStream: () => this.createPipeStream(),
      execute: options => this.execute({ ...options, kernel: this }),
      filesystem: this.filesystem,
      users: this.users,
      uid: 0,
      gid: 0,
      tty: 0,
      // KERNEL_NAME/KERNEL_VERSION/HOSTNAME: build-time constants a real execve'd worker process
      // has no other way to see (no `kernel` reference, no `window`) -- threaded through env the same
      // way HOME/PATH/etc already are, for uname.mjs/hostname.mjs to read via `env` in ecmaosSyscalls.
      env: { KERNEL_NAME: this.name, KERNEL_VERSION: this.version, HOSTNAME: 'localhost' }
    })

    this.terminal = new Terminal({
      context: this.context,
      dom: this.dom,
      kernel: this, // only for TerminalCommands -- see TerminalOptions.kernel's doc comment
      shell: this.shell,
      socket: this.options.socket,
      users: this.users,
      tty: 0
    })

    this.shell.attach(this.terminal)
    this._shells.set(0, this.shell)

    // Tier 4: subsystems whose real dependencies (terminal, shell) only exist now. Constructed
    // with context alone, then wired.
    this.protocol = new Protocol({})
    this.protocol.wire({ terminal: this.terminal })

    this.service = new Service({ context: this.context, filesystem: this.filesystem, ...this.options.service })
    this.service.wire({ shell: this.shell, terminal: this.terminal })

    this.terminal.wire({
      switchTty: (tty: number) => this.switchTty(tty),
      reboot: () => this.reboot(),
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
      await this.configure({ devices: this.options.devices || DefaultDevices, filesystem: Filesystem.options() })
      configureSpan.end()

      // Register ecmaOS's own custom syscalls (main-thread-only capabilities like DOM window
      // creation) before wrapping the table, so they get manifest-allowlist coverage too.
      installMainThreadSyscalls()

      // Wrap every registered syscall with a manifest-declared allowlist check, before any
      // program can execve and start calling them. A program with no manifest is unrestricted.
      installSyscallPolicy(this.filesystem.fs)

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
      filesystemSpan.end()

      if (!(await this.filesystem.fs.exists('/etc/os-release'))) {
        const osRelease = [
          `NAME="${this.name}"`,
          `VERSION="${this.version}"`,
          `ID=${this.name.toLowerCase().replace(/\s+/g, '')}`,
          `VERSION_ID="${this.version}"`,
          `PRETTY_NAME="${this.name} ${this.version}"`,
          import.meta.env['HOMEPAGE'] ? `HOME_URL="${import.meta.env['HOMEPAGE']}"` : ''
        ].filter(Boolean).join('\n') + '\n'

        await this.filesystem.fs.writeFile('/etc/os-release', osRelease, { mode: 0o444 })
      }

      if (!(await this.filesystem.fs.exists('/etc/hostname'))) {
        await this.filesystem.fs.writeFile('/etc/hostname', `${location.hostname || 'ecmaos'}\n`, { mode: 0o644 })
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
          await this.sudo(async () => {
            await this.filesystem.fs.writeFile(localeFilePath, 'LANG=en_US\n', { mode: 0o644 })
          })
        }
        
        // Detect browser language and override default system locale
        const browserLanguage = this.i18n.detectBrowserLanguage()
        const browserLocale = this.i18n.languageToLocale(browserLanguage)
        const systemLanguage = this.i18n.localeToLanguage(systemLocale)
        
        let finalLocale = systemLocale
        const isDefaultLanguage = browserLanguage === 'en' || browserLanguage.toLowerCase().startsWith('en-')
        
        if (!isDefaultLanguage && browserLanguage !== systemLanguage) {
          finalLocale = browserLocale
          await this.sudo(async () => {
            await this.filesystem.fs.writeFile(localeFilePath, `LANG=${finalLocale}\n`, { mode: 0o644 })
          })
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
            || getComputedStyle(document.documentElement).getPropertyValue('--figlet-font').trim()
            || 'Poison'
            

        const figletColor = options.figletColor
          || getComputedStyle(document.documentElement).getPropertyValue('--figlet-color').trim()
          || '#00FF00'

        const colorFiglet = (color: string, text: string) => {
          const rgb = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
          if (rgb) return chalk.rgb(parseInt(rgb[1] ?? 'FF'), parseInt(rgb[2] ?? 'FF'), parseInt(rgb[3] ?? 'FF'))(text)
          if (color.startsWith('#')) return chalk.hex(color)(text)
          return (chalk as unknown as { [key: string]: (text: string) => string })[color]?.(text) || text
        }

        let logoFiglet: string | undefined
        try {
          // TODO: A lot of trouble with Figlet fonts; revamp later - default to Poison now
          // const loadedFont = await import(`figlet/importable-fonts/${figletFont}.js`)
          const loadedFont = await import('figlet/importable-fonts/Poison.js')
          figlet.parseFont(figletFont || 'Poison', loadedFont.default)
          logoFiglet = figlet.textSync(import.meta.env['FIGLET_TEXT'] || 'ECMAOS', { font: figletFont as keyof typeof figlet.fonts })
          // TODO: Fancier detection of figlet width and terminal width
          if (document.body.clientWidth >= 650) this.terminal.writeln(colorFiglet(figletColor, logoFiglet))
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

        this.terminal.writeln(`${this.i18n.ns.kernel('madeBy')} ${this.terminal.createSpecialLink(
          import.meta.env['AUTHOR']?.url || 'https://github.com/mathiscode',
          `${import.meta.env['AUTHOR']?.name} <${import.meta.env['AUTHOR']?.email}>`
        )}`)

        this.terminal.writeln(import.meta.env['REPOSITORY'] + '\n')

        if (
          import.meta.env['KNOWN_ISSUES']
          && import.meta.env['ECMAOS_BOOT_DISABLE_ISSUES'] !== 'true'
          && !this.filesystem.fsSync.existsSync('/etc/noissues')
        ) {
          this.terminal.writeln(chalk.yellow.bold(this.i18n.ns.kernel('knownIssues')))
          this.terminal.writeln(chalk.yellow(import.meta.env['KNOWN_ISSUES'].map((issue: string) => `- ${issue}`).join('\n')) + '\n')
        }

        if (
          import.meta.env['ECMAOS_BOOT_DISABLE_TIPS'] !== 'true'
          && !this.filesystem.fsSync.existsSync('/etc/notips')
        ) {
          const tipsList = this.i18n.ns.kernel('tipsList', { returnObjects: true }) as string[]
          if (Array.isArray(tipsList) && tipsList.length > 0) {
            this.terminal.writeln(chalk.green.bold(this.i18n.ns.kernel('tips')))
            this.terminal.writeln(chalk.green(tipsList.map(tip => `- ${tip}`).join('\n')) + '\n')
          } else if (import.meta.env['TIPS']) {
            this.terminal.writeln(chalk.green.bold(this.i18n.ns.kernel('tips')))
            this.terminal.writeln(chalk.green(import.meta.env['TIPS'].map((tip: string) => `- ${tip}`).join('\n')) + '\n')
          }
        }

        spinner = this.terminal.spinner('arrow3', chalk.yellow(this.i18n.ns.common('Booting')))
        spinner.start()

        if (logoFiglet && import.meta.env['ECMAOS_BOOT_DISABLE_LOGO_CONSOLE'] !== 'true') {
          console.log(`%c${logoFiglet}`, 'color: green')
          console.log(`%c${import.meta.env['REPOSITORY'] || 'https://github.com/ecmaos/ecmaos'}`, 'color: blue; text-decoration: underline; font-size: 16px')
          this.log.info(`${import.meta.env['NAME'] || 'ecmaOS'} v${import.meta.env['VERSION']}`)
        }

        if (Notification?.permission === 'default') Notification.requestPermission()
        if (Notification?.permission === 'denied') this.log.warn(t('kernel.permissionNotificationDenied', 'Notification permission denied'))

        this.intervals.set('title-blink', () => {
          // Guards against firing after a test environment has torn down `document` -- this
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
          } catch {}
        }
      }

      // Log to /var/log/kernel.log
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

        this.sudo(async () =>
          await this.filesystem.fs.appendFile('/var/log/kernel.log',
            `${formattedDate} [${logObj._meta?.logLevelName}] ${logObj[0] || logObj.message}\n\n`
          )
        )
      })

      // Load core kernel features
      await this.registerEvents()
      // The standard /dev/{null,zero,full,random,urandom} memory devices -- @zenfs/linux ships
      // these ready-made (mem.js's own char_dev_init()), but nothing mounts them unless a caller
      // does so explicitly; ecmaOS's own web-capability devices (registerDevices, below) are a
      // separate, unrelated set. Real coreutils (dd, and anything reading /dev/urandom) depend on
      // these existing.
      initMemDevices()

      // Publishes xterm_driver's actual char-device operations (open/read/write/ioctl) for
      // /dev/xterm<n> -- `attach_xterm` (called per-terminal, in Terminal.mount()) only registers
      // each individual TTY's sysfs entry and DevTmpFS node via TTY.register(); it never calls the
      // *driver*-level TTYDriver.register() that reserves the major and adds a real CharDevice for
      // it (`char_dev.register_region` + `CharDevice.add`, done together inside
      // TTYDriver.register()). Without this, DevTmpFS._device() correctly resolves /dev/xterm0's
      // rdev to major 4 minor 192 (matching xterm_driver's own minor_start) but char_dev.lookup()
      // finds no CharDevice there at all, and every read/write on the node throws ENXIO -- caught
      // live: a real execve'd process writing to its console fd unredirected (the ordinary,
      // unredirected case, `bridgeStdio` only applies to redirected/piped stdio) hit this every
      // time; the fixed tests never noticed because they always redirect stdout/stderr somewhere
      // that never touches /dev/xterm0 as a real file. Registered once here, before any terminal's
      // first mount() -- `TTYDriver.register()` throws EBUSY on a second call, so this must not
      // also happen per-terminal.
      xterm_driver.register()

      // Same fix, for /dev/tty (5:0) and /dev/console (5:1) -- the fallback console path any real
      // `@zenfs/linux` Process with no explicit tty of its own opens by default (`console:
      // '/dev/console'`). Also never registered anywhere in ecmaOS; `console_driver.line(index)
      // .register(name)` is the per-line step (mirroring `@zenfs/linux`'s own `tty` Module init(),
      // which ecmaOS does not use), needed in addition to the driver-level `register()` above.
      console_driver.register()
      for (const [index, name] of ['tty', 'console'].entries()) console_driver.line(index).register(name)

      await this.registerDevices()
      await this.registerCommands()
      await this.registerPackages()

      // System crontab loading moved to `crond` itself (started from `/boot/init`) -- it parses
      // /etc/crontab on its own the moment it starts, rather than `boot()` pre-loading it into a
      // now-retired `kernel.intervals` cron registry.

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

            // Real @zenfs/linux Module: gets us /sys/module/<name>, refcounting, and dependency
            // tracking for free, replacing the bespoke enable/disable/cleanup contract this used
            // to call directly. A loaded package's own init/cleanup, if it has them, still run --
            // they're just driven by the Module's real init()/dispose() lifecycle now.
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
        usersSpan.setAttribute('users.count', this.users.all.size)
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
      
      await this.loginShell(this.shell, autoLogin ? { autoLogin } : undefined)
      
      if (autoLogin) {
        authSpan.setAttribute('auth.method', 'auto_login')
        authSpan.setAttribute('auth.username', autoLogin.username)
      }
      authSpan.end()

      // MOTD display and starting the real crond daemon both move into /sbin/init's script (via the
      // `motd` and `crond` commands) -- boot() only needs to get a shell running.
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

      // TODO: Fix initial prompt showing root as {user} substitution when not 0

      this.shell.cwd = localStorage.getItem(`cwd:${this.shell.credentials.uid}`) ?? (
        user.uid === 0 ? '/' : (user.home || '/')
      )

      // Registering the available screensavers (an `import.meta.glob`, resolved at build time
      // relative to this file) must stay here; starting the idle-timeout daemon does not -- see
      // `startScreensaverDaemon`, invoked from /sbin/init via the `screensaver-daemon` command.
      this.registerScreensavers()

      const initSpan = tracer.startSpan('kernel.boot.init', {}, trace.setSpan(context.active(), bootSpan))
      if (!await this.filesystem.fs.exists('/boot/init')) {
        await this.filesystem.fs.writeFile('/boot/init', [
          '#!ecmaos:bin:script:init',
          '',
          '# The real, editable boot script -- everything here used to run unconditionally',
          '# inside Kernel.boot() itself. What still can\'t move: anything needing a yes/no',
          '# branch (there is no `if` yet -- see the shell-jobs branch) stays in boot().',
          '# crond isn\'t started here -- a `crond &` line would background it onto this same',
          '# Shell\'s own job table (`_jobs`), the one the interactive session goes on to use, and',
          '# crond never finishes -- so a later bare `wait` (every non-done job) would hang forever.',
          '# It starts the same way /boot/init itself does: a raw Process, not a shell job.',
          'motd',
          'screensaver-daemon',
          ''
        ].join('\n'))
      }
      const initProcess = new Process({
        args: [],
        command: 'init',
        uid: user.uid,
        gid: user.gid,
        context: this.context,
        filesystem: this.filesystem,
        processes: this.processes,
        kernel: this,
        shell: this.shell,
        terminal: this.terminal,
        entry: async () => await this.sudo(async () => await this.execute({ command: '/boot/init', shell: this.shell }))
      })

      initProcess.keepAlive()
      // Awaited: /boot/init's own output (motd, screensaver-daemon, ...) must finish printing
      // before the recommended-apps prompt below writes its own -- unawaited, the two raced and
      // could interleave mid-line (e.g. "Do you want to install ... (Y/n)screensaver-daemon:
      // watching for idle activity" on the same line). keepAlive() only affects whether init's PID
      // file persists after it exits, not how long it runs -- /boot/init is a normal script that
      // finishes like any other, so awaiting it here does not hang boot.
      await initProcess.start()
      initSpan.end()

      // Started directly, not from /boot/init's own script text -- see the comment left in that
      // script for why: `kernel.execute()` here bypasses `Shell`'s own job-table bookkeeping
      // entirely (only `Shell.execute()`/`executeScriptText()`'s own pipeline parsing pushes onto
      // `this.shell`'s `_jobs`), so this never-finishing daemon can't ever show up in a later
      // `jobs`/`wait`. Fire-and-forget: `kernel.execute()`'s own promise only resolves once `crond`
      // itself exits, which is never during a normal run -- awaiting it here would hang boot.
      //
      // `foreground: false`: a daemon never owns the terminal. Left at the default it took over
      // `tty.foreground` (and, with the line discipline attached, the keyboard) for the whole
      // session, so every later `^C`/keystroke would have been aimed at crond, not the shell.
      void this.execute({ command: '/bin/crond', args: [], shell: this.shell, terminal: this.terminal, foreground: false })

      this._state = KernelState.RUNNING
      this.setupDebugGlobals()
      
      bootSpan.setAttribute('kernel.state', this._state)
      bootSpan.end()
      
      if (this.telemetry.active) {
        const provider = (this.telemetry as unknown as { _provider?: { forceFlush?: () => Promise<void> } })._provider
        if (provider?.forceFlush) {
          await provider.forceFlush().catch(() => {})
        }
      }

      // Install recommended apps if desired by user on first boot
      if (!this.storage.local.getItem('ecmaos:first-boot')) {
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

        this.storage.local.setItem('ecmaos:first-boot', Date.now().toString())
      }

      this.terminal.write(ansi.erase.inLine(2) + this.terminal.prompt())
      this.terminal.focus()
      this.terminal.listen()
    } catch (error) {
      bootSpan.recordException(error as Error)
      bootSpan.setStatus({ code: 2, message: (error as Error).message })
      bootSpan.setAttribute('kernel.state', KernelState.PANIC)
      bootSpan.end()
      this.log.error(error)
      this._state = KernelState.PANIC
      this.events.dispatch<KernelPanicEvent>(KernelEvents.PANIC, { error: error as Error })
      this.dom.toast.error({
        message: this.i18n.ns.kernel('panic'),
        duration: 0,
        dismissible: false
      })
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

    // Fallback to legacy fields if exports didn't yield a result
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
  async execute(options: KernelExecuteOptions): Promise<number> {
    try {
      if (!await this.filesystem.exists(options.command)) {
        this.log.error(`File not found for execution: ${options.command}`)
        return -1
      }

      const header = await this.readFileHeader(options.command, options.shell)
      if (!header) return -1

      let exitCode: number | void = -1
      switch (header.type) {
        case 'wasm':
          exitCode = await this.executeWasm(options)
          break
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
              exitCode = await this.executeCommand({ ...options, command: header.name })
              break
            case 'app':
              if (!header.name) return -1
              exitCode = await this.executeApp({ ...options, command: header.name, file: options.command })
              break
            case 'script':
              exitCode = await this.executeScript(options)
              break
            case 'node':
              exitCode = await this.executeViaExecve(options)
              break
            case 'device': {
              if (!header.name) return -1
              const device = this.devices.get(header.name)
              if (!device) return -1
              exitCode = await this.executeDevice(device.device, options.args)
              break
            }
          }; break
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
   * Executes an app
   * @param options - Execution options containing app path and shell
   * @returns Exit code of the app
   */
  async executeApp(options: KernelExecuteOptions): Promise<number> {
    try {
      const contents = await this.filesystem.fs.readFile(options.file!, 'utf-8')
      const binLink = await this.filesystem.fs.readlink(options.file!)
      const filePath = path.dirname(binLink)

      const blob = new Blob([await this.replaceImports(contents, filePath)], { type: 'text/javascript' })
      const url = URL.createObjectURL(blob)

      let exitCode = -1

      try {
        const module = await import(/* @vite-ignore */ url)
        const main = module?.main || module?.default

        if (typeof main !== 'function') throw new Error('No main function found in module')

        const process = this.processes.create({
          args: options.args || [],
          command: options.command,
          context: this.context,
          filesystem: this.filesystem,
          processes: this.processes,
          kernel: this,
          shell: options.shell || this.shell,
          terminal: options.terminal || this.terminal,
          uid: options.shell.credentials.uid,
          gid: options.shell.credentials.gid,
          entry: async (params) => await main(params),
          stdin: options.stdin,
          stdout: options.stdout,
          stderr: options.stderr
        })

        exitCode = await process.start()
      } finally {
        URL.revokeObjectURL(url)
      }

      return exitCode
    } catch (error) {
      this.log.error(`Failed to execute app: ${error}`)
      options.terminal?.writeln(chalk.red((error as Error).message))
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
    // Last-resort legacy shim -- a real, migrated command never reaches this method at all
    // (`readFileHeader` classifies its unshebanged file as `'js'`, routed through
    // `executeViaExecve`); this is only reached for a name still on the old in-process path. See
    // `resolveLegacyCommand`'s own doc comment (`@ecmaos/coreutils`) for the lazy, per-`Terminal`-
    // cached construction this does instead of `TerminalCommands` eagerly building all of them.
    const command = resolveLegacyCommand(kernel, shell, terminal, options.command, getKernelLegacyCommands())
    if (!command) return -1

    const process = new Process({
      uid: options.shell.credentials.uid,
      gid: options.shell.credentials.gid,
      args: options.args,
      command: options.command,
      context: this.context,
      filesystem: this.filesystem,
      processes: this.processes,
      kernel: options.kernel || this,
      shell: options.shell || this.shell,
      terminal: options.terminal || this.terminal,
      entry: async (params: ProcessEntryParams) => await command.run.call(params, params.pid, params.args),
      stdin: options.stdin,
      stdinIsTTY: options.stdinIsTTY,
      stdout: options.stdout,
      stdoutIsTTY: options.stdoutIsTTY,
      stderr: options.stderr
    })

    const exitCode = await process.start()
    return exitCode
  }

  /**
   * Executes a device command
   * @param {KernelDevice} device - Device to execute command on
   * @param {string[]} args - Command arguments
   * @param {Shell} shell - Shell instance
   * @returns {Promise<number>} Exit code of the device command
   */
  async executeDevice(device: KernelDevice, args: string[] = [], shell: Shell = this.shell): Promise<number> {
    if (!device || !device.cli) {
      this.log.error(`Device not found or does not have a CLI`)
      return -1
    }

    let deviceProcess: Process | null = new Process({
      uid: shell.credentials.uid,
      gid: shell.credentials.gid,
      args,
      command: `/dev/${device.pkg.name}`,
      entry: async (params: ProcessEntryParams) => await device.cli?.({
        args: params.args,
        kernel: params.kernel,
        pid: params.pid,
        shell: params.shell,
        terminal: params.terminal
      }),
      context: this.context,
      filesystem: this.filesystem,
      processes: this.processes,
      kernel: this,
      shell,
      terminal: this.terminal
    })

    try {
      shell.setPositionalParameters([`/dev/${device.pkg.name}`, ...args])
      await deviceProcess.start()
    } catch (error) {
      this.log.error(error)
      this.terminal.writeln(chalk.red((error as Error).message))
      return -2
    } finally {
      deviceProcess = null
    }

    return 0
  }

  /**
   * Runs a plain JS/ESM file as a real, isolated process via `@zenfs/linux`'s `execve` -- the
   * genuine replacement for both the old main-thread `new Function(code)` eval (`executeJavaScript`)
   * and the old `executeNode`'s blob-import shim (which patched `globalThis.process` and had no
   * isolation at all). `@zenfs/linux` already registers a default `binfmt_js` matching any
   * non-WASM, non-null-byte file and pointing it at `/bin/node` as its interpreter; `Filesystem`
   * writes that interpreter's real bundled source to `/bin/node` at boot (see `src/bin/node.mjs`).
   *
   * Real, working today: a self-contained script (no import/require) run to completion with a real
   * exit code, on its own real worker thread, with real syscalls for anything it does.
   *
   * Not yet supported, and why: a program that itself imports something. The interpreter has no
   * import-rewriting (the SWAPI mechanism `replaceImports` uses for main-thread apps would need its
   * own worker-side port -- real scope of its own).
   *
   * Redirected stdio (`>`, `|`) IS wired, via `bridgeStdio` below -- `@zenfs/linux@0.5.0`'s real
   * `create_pipe` (`fs/pipe.ts`) is the fd-backed primitive this needed, and it landed after this
   * doc comment first recorded the gap.
   *
   * @param options - Execution options containing the file path and shell
   * @returns Exit code of the process
   */
  async executeViaExecve(options: KernelExecuteOptions): Promise<number> {
    if (!options.command) return -1
    const terminal = options.terminal || this.terminal
    const tty = terminal.zfsTty
    const isForeground = options.foreground ?? true

    // `tty->pgrp`: the process a `TIOCGPGRP`/`TIOCSPGRP` ioctl against this terminal answers with.
    // Only a foreground stage takes it over, and only for as long as it runs -- a backgrounded (`&`)
    // pipeline's process must never appear to own the terminal it isn't attached to. Restored to
    // whatever it was before (not unconditionally cleared) so a foreground process launched from
    // inside another foreground process's stage -- there is no nesting today, but this is the
    // correct rule regardless -- hands control back up rather than to nobody.
    const previousForeground = tty?.foreground
    const stopBridges: Array<() => void> = []

    try {
      const proc = new ZenFSProcess({
        argv: [options.command, ...(options.args || [])],
        env: options.shell.envObject,
        cwd: options.shell.cwd,
        tty,
        // Process opens stdio against this path, not `tty` directly -- `tty` only sets the
        // foreground-process/signal-delivery side of things.
        console: tty ? `/dev/${tty.name}` : undefined
      })

      // Custom syscalls whose handler needs a `Kernel` (e.g. `window_create`) resolve it from the
      // calling `Process` -- `@zenfs/linux`'s `Process` has no notion of "kernel" itself, and the
      // syscall table is module-global, shared across every `Kernel` instance in the page/process.
      registerProcessKernel(proc, this, options.shell)

      if (tty && isForeground) tty.foreground = proc

      // A foreground stage owns the keyboard through the real line discipline (`^C`/`^Z` via ISIG,
      // canonical or raw reads, echo) for as long as it is the terminal's foreground process --
      // `Terminal.attachInput` explains why. `fg`/`bg`/`^Z` move that ownership through
      // `setForeground` below, the same way they move `tty.foreground`.
      let releaseInput: (() => void) | undefined
      const grabInput = () => { releaseInput ??= terminal.attachInput() }
      const dropInput = () => { releaseInput?.(); releaseInput = undefined }
      if (tty && isForeground) grabInput()
      stopBridges.push(dropInput)

      // The line discipline raises `^Z` as `SIGTSTP` straight on the process, and `@zenfs/linux`
      // only flips `proc.stopped` -- it emits nothing -- so observe the transition here, where the
      // signal lands, to hand the terminal back to the shell.
      const deliver = proc.kill.bind(proc)
      proc.kill = (signal) => {
        const wasStopped = proc.stopped
        const delivered = deliver(signal)
        if (!wasStopped && proc.stopped && tty?.foreground === proc) {
          dropInput()
          terminal.foregroundStopped()
        }
        return delivered
      }

      // Redirected/piped stdio: only bridge a standard descriptor the caller actually gave a real
      // stream for and that isn't just the plain console -- the overwhelmingly common case (a
      // foreground command with no `>`/`|`) needs no bridge at all.
      if (options.stdin && !options.stdinIsTTY) stopBridges.push(this.bridgeStdio(proc, 0, options.stdin))
      if (options.stdout && !options.stdoutIsTTY) stopBridges.push(this.bridgeStdio(proc, 1, options.stdout))
      if (options.stderr) stopBridges.push(this.bridgeStdio(proc, 2, options.stderr))

      // Hand the real Process to the shell's job table (if it's tracking one for this stage)
      // before awaiting completion -- this is the only handle job control (`^C`/`^Z`/`fg`/`bg`)
      // ever gets to signal a real process; see `KernelExecuteOptions.onProcess`'s doc comment.
      // `setForeground` closes over `tty` so `Shell.fg`/`bg` can move terminal ownership later,
      // after this stage has already started -- see `JobProcessHandle.setForeground`'s doc comment.
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

      // `@zenfs/linux`'s own `execve()` unconditionally does `proc.tty.foreground = proc` once the
      // program actually loads (`fs/exec.ts`), on the assumption that exec-ing is itself a
      // foreground act -- true for a real shell's fork+exec, not true for ecmaOS's backgrounded (`&`)
      // stage, which calls this same codepath directly with no fork in between. Put it right back
      // for a backgrounded stage; a foreground one was already correct (redundant, but harmless).
      if (tty && !isForeground && tty.foreground === proc) tty.foreground = previousForeground

      const exitCode = await proc.exited

      // The line discipline echoed `^C` with no newline (a real shell's tty driver ends the line
      // for it); without this the next prompt is drawn after the `^C`, mid-line.
      if (tty && isForeground && proc.killed_by === ZenFSSignal.INT) terminal.write('\r\n')

      // Give the stdout/stderr bridges a moment to drain whatever the program wrote right before
      // exiting -- `bridgeStdio`'s own drain-on-exit path stops promptly on its own, but the
      // pipeline's next stage (or a redirect target file) should see every byte before this stage
      // is reported done.
      await new Promise(resolve => setTimeout(resolve, 15))

      return exitCode
    } catch (error) {
      this.log.error(`Failed to execute ${options.command}: ${error}`)
      terminal?.writeln(chalk.red(error instanceof Error ? error.message : String(error)))
      return -1
    } finally {
      for (const stop of stopBridges) stop()
      if (tty && isForeground) tty.foreground = previousForeground
    }
  }

  /**
   * Replaces `proc`'s fd `stdFd` (0/1/2) with one end of a real `@zenfs/linux` pipe (via
   * `create_pipe`), and pumps the other end against `stream` on the main thread.
   *
   * The pipe is created on `this.pipeProcess`'s context (a dedicated, kernel-lifetime, never-
   * `execve`'d `Process` -- not any given `Process`'s own context, deliberately: `Process.exit()`
   * (`fs/process.ts`) closes every descriptor still open in its own context when it exits, which
   * would otherwise race this pump loop's own close/drain the instant the program exits. It has to
   * be a real, *registered* `Process` (not a bare `bindContext()` `FSContext`, tried first) because
   * `fs/pipe.ts`'s own `write` throws `EPIPE` unless `open_ends()` finds the other end referenced
   * by some `Process` in `@zenfs/linux`'s module-level `processes` map -- confirmed by hand against
   * the published package. A `Handle` carries its own context reference internally and works
   * correctly against whichever map holds it, so the program's end is still handed to it by
   * copying the `Handle` object into `proc.context.descriptors` at the standard slot -- only the
   * *bridge* end stays on `pipeProcess`'s context, safe from the running program's own exit, and is
   * this method's own job to close.
   *
   * `create_pipe` always hands back the lowest free fd on whichever context it's given (never a
   * specific one), so the swap onto `stdFd` is done by hand on the descriptor map -- a plain
   * `Map<number, Handle>` -- rather than through a `dup2` syscall, which only exists worker-side
   * for a running program to call on itself.
   *
   * Reading/writing goes through `pipefs`'s own `read_device`/`write_device`/`_device` (exported
   * from `fs/pipe.ts` alongside `create_pipe`, despite being marked `@internal`) rather than
   * `@zenfs/core`'s generic `fs.readSync`/`writeSync` -- confirmed by hand that the generic path
   * does not special-case a pipe at all (`written` succeeds silently but a same-pipe `read` always
   * comes back empty); only the syscall table's own `read`/`write` handlers know to route through
   * `device_of()` to these, and they aren't reachable from outside a real worker's syscall dispatch.
   *
   * The pump itself polls: `read_device` is genuinely non-blocking (an empty read returns 0
   * immediately, confirmed by reading `fs/pipe.ts`'s `pipe_ops.read`/`take`), so there is no risk
   * of stalling the main thread here -- just of checking more often than necessary, which a short
   * interval keeps cheap. Reaching the pipe's own `WaitQueue` to await instead of poll would need
   * `Pipe` internals `@zenfs/linux` does not export; polling is the honest, available option today.
   */
  private bridgeStdio(
    proc: InstanceType<typeof ZenFSProcess>,
    stdFd: 0 | 1 | 2,
    stream: ReadableStream<Uint8Array> | WritableStream<Uint8Array>
  ): () => void {
    // fd 0 is the program's stdin: it reads from the pipe we write into
    return this.bridgeFd(proc, stdFd, stdFd === 0 ? 'read' : 'write', stream).stop
  }

  /**
   * Gives `proc` a brand-new descriptor (the lowest free one from 3) that is one end of a real pipe
   * pumped against `stream`, and returns its number: a `'read'` descriptor the program reads what
   * `stream` produces from, a `'write'` one whose bytes are delivered to `stream`. This is how a
   * kernel-side resource (a socket) becomes something a real program can `read`, `write` and `poll`
   * like any other fd. Same machinery, same caveats as {@link bridgeStdio}, which this generalizes.
   */
  attachStream(
    proc: InstanceType<typeof ZenFSProcess>,
    direction: 'read' | 'write',
    stream: ReadableStream<Uint8Array> | WritableStream<Uint8Array>
  ): { fd: number, stop: () => void } {
    let fd = 3
    while (proc.context.descriptors.has(fd)) fd++
    return { fd, stop: this.bridgeFd(proc, fd, direction, stream, { closeOnEof: true }).stop }
  }

  private bridgeFd(
    proc: InstanceType<typeof ZenFSProcess>,
    stdFd: number,
    direction: 'read' | 'write',
    stream: ReadableStream<Uint8Array> | WritableStream<Uint8Array>,
    // `closeOnEof`: end a `'write'` stream as soon as the program closes its end and what it wrote
    // has drained (shutdown of the write side), instead of only when the program exits. Stdio
    // leaves this off -- it has always ended with the process -- but a socket needs it to half-close.
    { closeOnEof = false }: { closeOnEof?: boolean } = {}
  ): { stop: () => void } {
    const pipeProcCtx = this.pipeProcess.context

    const [pipeReadFd, pipeWriteFd] = create_pipe(pipeProcCtx)
    const programFd = direction === 'read' ? pipeReadFd : pipeWriteFd
    const bridgeFd = direction === 'read' ? pipeWriteFd : pipeReadFd

    // Copy the program-facing end's Handle onto proc's standard slot, then drop it from
    // `pipeProcCtx` (not close -- the fd number itself was never meaningful to the program, only
    // its Handle was worth keeping). The console's original handle at that slot is simply
    // discarded, uninvolved: the other one or two standard descriptors sharing its dup are
    // untouched, matching how a real process' fd 0/1/2 dups all point at one open regardless.
    const programHandle = pipeProcCtx.descriptors.get(programFd)
    pipeProcCtx.descriptors.delete(programFd)
    if (programHandle) proc.context.descriptors.set(stdFd, programHandle)

    const bridgeHandle = pipeProcCtx.descriptors.get(bridgeFd)
    const bridgeFile = bridgeHandle && pipefs._device(bridgeHandle.internalPath)
    if (!bridgeFile) {
      this.log.error(`bridgeStdio: could not resolve fd ${stdFd}'s pipe device; leaving it on the console`)
      return { stop: () => {} }
    }

    let stopped = false
    const stop = () => { stopped = true }

    if (direction === 'write') {
      // stdout/stderr: drain the pipe's read end into `stream` until the program closes its write
      // end (proc.exited) and the pipe is empty.
      const writer = (stream as WritableStream<Uint8Array>).getWriter()
      void (async () => {
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
            if (await Promise.race([proc.exited.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10))])) {
              // Program has exited (closing its end); drain whatever is left, then stop.
              const drain = new Uint8Array(65536)
              let m: number
              do { m = pipefs.read_device(bridgeFile, drain, 0, drain.byteLength); if (m > 0) await writer.write(drain.subarray(0, m)) } while (m > 0)
              break
            }
          }
        } catch (error) {
          this.log.error(`stdio bridge (fd ${stdFd}) failed: ${error}`)
        } finally {
          try { pipeProcCtx.descriptors.delete(bridgeFd) } catch { /* already gone */ }
          try { await writer.close() } catch { /* already closed by the pipeline's next stage */ }
        }
      })()
    } else {
      const reader = (stream as ReadableStream<Uint8Array>).getReader()
      void (async () => {
        try {
          while (!stopped) {
            const { done, value } = await reader.read()
            if (done) break
            let offset = 0
            while (offset < value.byteLength) {
              const n = pipefs.write_device(bridgeFile, value.subarray(offset), 0)
              if (n > 0) { offset += n; continue }
              await new Promise(resolve => setTimeout(resolve, 10))
            }
          }
        } catch (error) {
          this.log.error(`stdio bridge (fd ${stdFd}) failed: ${error}`)
        } finally {
          try { pipeProcCtx.descriptors.delete(bridgeFd) } catch { /* already gone */ }
          // Dropping the last write end is what tells a reader the stream is over (EOF), but
          // `@zenfs/linux` only wakes a pipe's sleepers when data moves, not when an end closes -- a
          // program blocked in `poll`/`read` on this fd would sleep forever. Wake it ourselves.
          pipefs._end(bridgeFile.path)?.pipe.wait.wake_up()
        }
      })()
    }

    return { stop }
  }

  /**
   * A real `@zenfs/linux` `create_pipe`-backed drop-in for `new TransformStream()`, used by
   * `Shell.runPipeline` to join one pipeline stage's stdout to the next stage's stdin -- closing
   * the plan's last open item (`.docs/overhaul/STATUS_01.md` recommendation #3): pipeline stages
   * were still joined by a plain web `TransformStream`, never the real `pipe` syscall, even after
   * `bridgeStdio` proved the primitive itself works.
   *
   * Both ends of the real pipe are anchored on `this.pipeProcess`'s context, exactly as
   * `bridgeStdio` above anchors its own ends and for the identical reason: `fs/pipe.ts`'s `write`
   * throws `EPIPE` unless `open_ends()` finds the *other* end referenced by some registered
   * `Process`, and a stage's own `Process` (when it has one at all -- a legacy in-process coreutil
   * has none) would tear its end down on its own exit timing, racing whichever side is still
   * draining it. Anchoring both ends on the same kernel-lifetime process sidesteps that regardless
   * of what kind of thing is on either side of the join (a real `execve`'d `Process`, or a legacy
   * coreutil closure that only ever sees the returned `readable`/`writable` web streams).
   *
   * Reads/writes go through `pipefs`'s own `read_device`/`write_device`, not `@zenfs/core`'s
   * generic `fs.readSync`/`writeSync` -- confirmed by hand (see `bridgeStdio`'s own doc comment)
   * that the generic path silently doesn't work on a pipe at all.
   */
  private createPipeStream(): { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> } {
    const pipeProcCtx = this.pipeProcess.context
    const [readFd, writeFd] = create_pipe(pipeProcCtx)
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
    const writable = new WritableStream<Uint8Array>({
      // `write_device` never blocks -- it's a short write (`Pipe.put`, `fs/pipe.ts`), returning 0
      // once the pipe's fixed 65536-byte capacity is full, on the assumption that a real blocking
      // `write(2)` syscall would suspend the calling thread until the reader drains it. There is no
      // thread to suspend here (this callback runs on the main thread, same as the `pull` below
      // that would do the draining), so a synchronous retry loop with no `await` would spin forever
      // without ever giving `pull` a turn -- confirmed by hand: a payload bigger than one pipe's
      // capacity written in a single chunk hung the test suite before this `await` was added.
      write: async chunk => {
        let offset = 0
        while (offset < chunk.byteLength) {
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
      cancel: () => {
        pipeProcCtx.descriptors.delete(readFd)
      }
    })

    return { readable, writable }
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

      const process = new Process({
        uid: options.shell.credentials.uid,
        gid: options.shell.credentials.gid,
        args: options.args || [],
        command: options.command,
        context: this.context,
        filesystem: this.filesystem,
        processes: this.processes,
        kernel: this,
        shell: options.shell || this.shell,
        terminal: options.terminal || this.terminal,
        entry: async () => {
          if (needsWasi) {
            const result = await this.wasm.loadWasiComponent(options.command, {
              stdin,
              stdout,
              stderr
            }, [options.command, ...(options.args || [])], options.shell || this.shell, process.pid)
            return await result.exitCode
          } else {
            const { instance } = await this.wasm.loadWasm(options.command)
            const exports = instance.exports
            
            if (typeof exports._start === 'function') {
              try {
                (exports._start as () => void)()
                return 0
              } catch (error) {
                this.log.error(`WASM _start failed: ${(error as Error).message}`)
                return 1
              }
            } else if (typeof exports._initialize === 'function') {
              try {
                (exports._initialize as () => void)()
                return 0
              } catch (error) {
                this.log.error(`WASM _initialize failed: ${(error as Error).message}`)
                return 1
              }
            }
            return 0
          }
        },
        stdin,
        stdinIsTTY: options.stdinIsTTY,
        stdout,
        stdoutIsTTY: options.stdoutIsTTY,
        stderr
      })

      const exitCode = await process.start()
      return exitCode
    } catch (error) {
      this.log.error(`Failed to execute WASM: ${error}`)
      terminal?.writeln(chalk.red((error as Error).message))
      return -1
    } finally {
      if (keyListener) {
        keyListener.dispose()
        keyListener = null
      }
      if (shouldUnlisten) {
        terminal.listen()
      }
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

    const script = await options.shell.context.fs.promises.readFile(options.command, 'utf-8')
    if (script) {
      const terminalCmdBefore = options.terminal?.cmd || ''

      // Multi-line control flow (if/while/for/case), functions, and `set -e/-u/-o pipefail` all
      // live in the statement tree `executeScriptText` walks -- the old per-line `execute()` loop
      // here had no way to let a `then`/`do`/`fi` span lines at all.
      const exitCode = await options.shell.executeScriptText(script)

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
    if (Notification?.permission === 'granted') return new Notification(title, options)
    await Notification.requestPermission()
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

      const checkExtensionType = (filePath: string): FileHeader['type'] | null => {
        if (filePath.endsWith('.js')) return 'js'
        else if (filePath.endsWith('.md')) return 'view'
        else if (filePath.endsWith('.json')) return 'view'
        else if (filePath.endsWith('.txt')) return 'view'
        // A file under /bin with no shebang and no magic bytes at all is a real, migrated coreutil
        // (see `feat/1.0.0-execve-commands`) -- bundled JS, same content shape as any `.js` fixture,
        // just installed without the extension since it's meant to be run bare (`/bin/<name>`, not
        // `/bin/<name>.js`). `@zenfs/linux`'s own `binfmt_js` (fs/exec.ts) already accepts this
        // content unconditionally by matching "not WASM, no null byte" -- this only teaches ecmaOS's
        // own pre-execve classification (`readFileHeader`) the same rule for this one directory,
        // rather than requiring every migrated command to keep the legacy `#!ecmaos:bin:command:`
        // stub just to be found.
        else if (filePath.startsWith('/bin/')) return 'js'
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
              const extensionType = checkExtensionType(filePath)
              return extensionType ? resolve({ type: extensionType }) : resolve(null)
            }
          })
          
          readable.on('error', (error: Error) => reject(error))
          readable.on('close', () => {
            readable.destroy()
            const extensionType = checkExtensionType(filePath)
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
      
      const extensionType = checkExtensionType(filePath)
      return extensionType ? { type: extensionType } : null
    } catch (error) {
      this.log.error(error)
      throw error
    }
  }

  /**
   * Reboots the kernel by performing a shutdown and page reload
   */
  async reboot() {
    this.log.warn(this.i18n.ns.common('Rebooting'))
    await this.shutdown()
    globalThis.location.reload()
  }

  /**
   * Registers the terminal commands.
   * @returns {Promise<void>} A promise that resolves when the terminal commands are registered.
   */
  async registerCommands() {
    if (!await this.filesystem.fs.exists('/bin')) await this.filesystem.fs.mkdir('/bin')

    // Real Linux has no equivalent of this method at all -- `execve`+`$PATH` resolve a command
    // purely off real files on disk. This exists only for the commands that aren't real files yet:
    // a name real `execve` already handles gets its actual bundled program written here (no
    // registry/manifest lookup needed to run it, only to know it needs a file at all); a name still
    // on the old in-process path gets the legacy `#!ecmaos:bin:command:` stub `readFileHeader`
    // recognizes to route it through `executeCommand`'s shim. Building only names + this cheap
    // check (not full `TerminalCommand` construction) is what makes this free regardless of how
    // many legacy commands remain -- `getLegacyCommands()`/`getKernelLegacyCommands()` hand back
    // `{ description, createCommand }` pairs, but only `Object.keys(...)` is used here.
    //
    // True shell builtins (`cd`, `export`, ... -- see `lib/shell-builtins.ts`) get NO `/bin/<name>`
    // file at all, matching real bash having no `/bin/cd` -- `Shell.execute` dispatches them before
    // any file-based resolution is even attempted.
    const names = [
      ...Object.keys(migratedCommandSources),
      ...Object.keys(migratedKernelCommandSources),
      ...Object.keys(getLegacyCommands()),
      ...Object.keys(getKernelLegacyCommands())
    ].filter(name => !this.options.blacklist?.commands?.includes(name))

    for (const name of names) {
      const target = `/bin/${name}`
      const source = migratedCommandSources[name] ?? migratedKernelCommandSources[name] ?? `#!ecmaos:bin:command:${name}`
      // The root persists across page loads, so an existing file is only kept if it already holds
      // exactly this build's program; otherwise an upgraded (or fixed) command would never reach
      // an existing install, which would keep running whatever version first created the file.
      if (await this.filesystem.fs.exists(target) && await this.filesystem.fs.readFile(target, 'utf8') === source) continue
      await this.filesystem.fs.writeFile(target, source, { mode: 0o755 })
    }
  }

  /**
   * Registers the devices.
   *
   * `char_dev.register` claims an entire major (all 256 minors) for one `FileOperations` object, so
   * a package that returns more than one {@link KernelCharDevice} under the same major is registered
   * once per distinct major, with a dispatcher that routes to the right entry's own `ops` by minor
   * — the same pattern `@zenfs/linux`'s own `mem.js` uses for `/dev/{null,zero,full,random}`.
   *
   * @returns {Promise<void>} A promise that resolves when the devices are registered.
   */
  async registerDevices() {
    // `char_dev.register(major, ...)` reserves an entire major (all 256 minors) for one caller --
    // it is keyed by major alone, not major+name. Linux's real convention is exactly this: many
    // unrelated drivers share major 10 ("misc") and differentiate only by minor (battery=100,
    // geo=101, sensors=102, presentation=156, ...). So the grouping-by-major below MUST happen
    // across every device package's drivers together, not per-package -- grouping per-package (as
    // an earlier version of this method did) calls char_dev.register(10, ...) once per package
    // that wants major 10, and every call after the first fails with EBUSY, silently dropping that
    // package's device node. Collect every driver from every package first, then group globally.
    const allDrivers: { device: (typeof DefaultDevices)[string]; driver: KernelCharDevice }[] = []

    for (const device of Object.values(this.options.devices || DefaultDevices)) {
      const drivers = await device.getDrivers(this.context)
      this.devices.set(device.pkg.name, { device, drivers })
      for (const driver of drivers) allDrivers.push({ device, driver })
    }

    const byMajor = new Map<number, typeof allDrivers>()
    for (const entry of allDrivers) {
      const group = byMajor.get(entry.driver.major) ?? []
      group.push(entry)
      byMajor.set(entry.driver.major, group)
    }

    for (const [requestedMajor, group] of byMajor) {
      const dispatch = (file: Parameters<NonNullable<FileOperations['read']>>[0]) => {
        const entry = group.find(({ driver }) => driver.minor === file.devt.minor)
        if (!entry) throw new Error(`No device registered at minor ${file.devt.minor}`)
        return entry.driver.ops
      }

      const ops: FileOperations = {
        open: file => dispatch(file).open?.(file),
        release: file => dispatch(file).release?.(file),
        read: (file, buffer, start, end) => dispatch(file).read?.(file, buffer, start, end),
        write: (file, buffer, offset) => dispatch(file).write?.(file, buffer, offset),
        sync: file => dispatch(file).sync?.(file),
        poll: file => dispatch(file).poll?.(file) ?? 0,
        poll_wait: file => dispatch(file).poll_wait?.(file)
      }

      // char_dev majors and device names are process-global in @zenfs/linux, not scoped per
      // Kernel instance, so a second Kernel booted in the same JS realm (as tests do across
      // describe blocks) re-requests majors and names the first instance already claimed.
      // That is not a real conflict -- it is the same set of drivers, offered twice -- so
      // EBUSY/EEXIST here are swallowed rather than treated as a boot failure.
      let major: number
      try {
        major = char_dev.register(requestedMajor, `major-${requestedMajor}`, ops)
      } catch (error) {
        this.log.warn(`Device major ${requestedMajor} already registered: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }

      for (const { driver } of group) {
        try {
          new Device({ name: driver.name, class: driver.class, dev_t: { major, minor: driver.minor } }).register()
        } catch (error) {
          this.log.warn(`Device node ${driver.name} already registered: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

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
          // default:
          //   this.log.debug('KernelEvent:', event, { command, args, exitCode })
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
    } catch {}
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
   * Starts the idle-timeout screensaver daemon: watches for user activity and shows the configured
   * screensaver (`localStorage['screensaver']`, default `matrix`) after a period of none
   * (`localStorage['screensaver-timeout']` ms, default 60000). Extracted out of `boot()` so it can
   * be started from `/sbin/init` (via the `screensaver-daemon` command) instead of unconditionally
   * on every boot.
   * @returns a function that stops the daemon and removes its listeners, or undefined if the
   * configured screensaver isn't a registered one
   */
  startScreensaverDaemon(): (() => void) | undefined {
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
          await this.sudo(async () => {
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
              shell: this.shell,
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
          })
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
   * Replaces imports in a script with SWAPI URLs
   *
   * @remarks
   * I would love to just use import maps, but we need dynamic import maps
   * This is probably not our long-term solution
   *
   * @param {string} contents - The script contents
   * @returns {Promise<string>} The modified script contents
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

  /**
   * Shuts down the kernel.
   * @returns {Promise<void>} A promise that resolves when the kernel is shut down.
   */
  async shutdown() {
    this.terminal.unlisten()
    this._state = KernelState.SHUTDOWN
    this.events.dispatch<KernelShutdownEvent>(KernelEvents.SHUTDOWN, { data: {} })
  }

  /**
   * Updates the i18n language from the LANG environment variable if present
   * This allows users to override the system-wide locale with their LANG env var
   */
  private updateLocaleFromEnv(): void {
    const langEnv = this.shell.env.get('LANG')
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
    const t = this.i18n.i18next.getFixedT(this.i18n.language, 'kernel')

    if (options?.autoLogin) {
      const { user, cred } = await this.users.login(options.autoLogin.username, options.autoLogin.password)
      shell.credentials = cred
      shell.context = bindContext({ root: '/', pwd: '/', credentials: cred })
      shell.env.set('UID', user.uid.toString())
      shell.env.set('GID', user.gid.toString())
      shell.env.set('SUID', cred.suid.toString())
      shell.env.set('SGID', cred.sgid.toString())
      shell.env.set('EUID', cred.euid.toString())
      shell.env.set('EGID', cred.egid.toString())
      shell.env.set('SHELL', user.shell || 'ecmaos')
      shell.env.set('HOME', user.home || '/root')
      shell.env.set('USER', user.username)
      shell.env.set('HOSTNAME', globalThis.location.hostname || 'localhost')
      process.env = Object.fromEntries(shell.env)
      await shell.loadEnvFile()
      await shell.loadConfig()
      this.updateLocaleFromEnv()
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
        const user = Array.from(this.users.all.values()).find(u => u.username === username)
        
        let loginSuccess = false
        let userCred: { user: User, cred: Credentials } | null = null

        if (user) {
          const passkeys = await this.users.getPasskeys(user.uid)
          if (passkeys.length > 0 && this.auth.passkey.isSupported()) {
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
              
              if (credential && credential instanceof PublicKeyCredential) {
                userCred = await this.users.login(username, undefined, credential)
                loginSuccess = true
              } else {
                terminal.writeln(chalk.yellow(t('kernel.passkeyCancelled', 'Passkey authentication cancelled or failed. Falling back to password...')))
              }
            } catch (err) {
              terminal.writeln(chalk.yellow(t('kernel.passkeyError', 'Passkey authentication error: {{error}}. Falling back to password...', { error: (err as Error).message })))
            }
          }
        }

        if (!loginSuccess) {
          const password = await terminal.readline(`🔑  ${this.i18n.ns.common('Password')}: `, true)
          userCred = await this.users.login(username, password)
        }

        if (!userCred) throw new Error(this.i18n.ns.kernel('loginFailed'))

        shell.credentials = userCred.cred
        shell.context = bindContext({ root: '/', pwd: '/', credentials: userCred.cred })
        await shell.loadEnvFile()
        await shell.loadConfig()
        shell.env.set('UID', userCred.user.uid.toString())
        shell.env.set('GID', userCred.user.gid.toString())
        shell.env.set('SUID', userCred.cred.suid.toString())
        shell.env.set('SGID', userCred.cred.sgid.toString())
        shell.env.set('EUID', userCred.cred.euid.toString())
        shell.env.set('EGID', userCred.cred.egid.toString())
        shell.env.set('SHELL', userCred.user.shell || 'ecmaos')
        shell.env.set('HOME', userCred.user.home || '/root')
        shell.env.set('USER', userCred.user.username)
        process.env = Object.fromEntries(shell.env)
        
        const langEnv = shell.env.get('LANG')
        if (langEnv) {
          try {
            this.i18n.setLanguage(langEnv)
            this.log.debug(`Locale updated from LANG env var: ${langEnv} -> ${this.i18n.language}`)
          } catch (error) {
            this.log.warn(`Failed to update locale from LANG env var: ${(error as Error).message}`)
          }
        }
        break
      } catch (err) {
        console.error(err)
        terminal.writeln(chalk.red((err as Error).message) + '\n')
      }
    }
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
      reboot: () => this.reboot(),
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
      filesystem: this.filesystem,
      users: this.users,
      uid: 0,
      gid: 0,
      tty: ttyNumber,
      terminal,
      env: { KERNEL_NAME: this.name, KERNEL_VERSION: this.version, HOSTNAME: 'localhost' }
    })
    terminal.attachShell(shell)

    this._shells.set(ttyNumber, shell)

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

    shell.cwd = localStorage.getItem(`cwd:${shell.credentials.uid}`) ?? (
      user.uid === 0 ? '/' : (user.home || '/')
    )

    const motd = await this.filesystem.fs.exists('/etc/motd')
      ? await this.filesystem.fs.readFile('/etc/motd', 'utf-8')
      : null

    if (motd) terminal.writeln('\n' + motd)

    terminal.write(ansi.erase.inLine(2) + terminal.prompt())
    terminal.focus()

    return shell
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

    requestAnimationFrame(() => {
      if (targetShell.terminal.addons?.get('fit')) (targetShell.terminal.addons.get('fit') as FitAddon).fit()
      targetShell.terminal.focus()
      targetShell.terminal.listen()
    })
  }

  /**
   * Executes an operation with root (or other) privileges
   * @param {() => Promise<T>} operation - Operation to execute
   * @param {Partial<Credentials>} cred - Optional credentials to use
   * @returns {Promise<T>} Result of the operation
   */
  private async sudo<T>(
    operation: () => Promise<T>,
    cred: Credentials = { uid: 0, gid: 0, suid: 0, sgid: 0, euid: 0, egid: 0, groups: [] }
  ): Promise<T | undefined> {
    const currentCredentials = { ...this.shell.credentials }
    const currentContext = { ...this.shell.context }
    let result: T | undefined

    try {
      this.shell.credentials = cred
      this.shell.context = bindContext({ root: '/', pwd: '/', credentials: cred })
      result = await operation()
    } catch (error) {
      this.log.error(error)
    } finally {
      this.shell.credentials = currentCredentials
      this.shell.context = currentContext
    }

    return result
  }

  /**
   * Sets up global debug utilities for browser console access.
   * Access via: ecmaos.kernel, ecmaos.processes(), ecmaos.fd(pid?), etc.
   */
  private setupDebugGlobals() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ecmaos = (globalThis as any).ecmaos || {}
    
    Object.assign(ecmaos, {
      // Core references
      kernel: this,
      
      // Process utilities
      processes: () => {
        const procs = Array.from(this.processes.all.values()) as Process[]
        console.table(procs.map((p: Process) => ({
          pid: p.pid,
          command: p.command,
          status: p.status,
          uid: p.uid,
          gid: p.gid,
          cwd: p.cwd
        })))
        return procs
      },
      
      // File descriptor table for a specific process
      fd: (pid?: number) => {
        if (pid === undefined) {
          // Show all processes and their fd info
          const procs = Array.from(this.processes.all.values()) as Process[]
          for (const proc of procs) {
            console.group(`PID ${proc.pid}: ${proc.command}`)
            console.log('stdin:', proc.fd.stdin ? '✓' : '✗')
            console.log('stdout:', proc.fd.stdout ? '✓' : '✗')
            console.log('stderr:', proc.fd.stderr ? '✓' : '✗')
            console.log('tracked file handles:', proc.fd.fileHandles.length)
            console.groupEnd()
          }
          return procs.map(p => ({ pid: p.pid, fd: p.fd }))
        }
        
        const proc = this.processes.get(pid) as Process | undefined
        if (!proc) {
          console.error(`Process ${pid} not found`)
          return null
        }
        
        console.group(`FDTable for PID ${pid}: ${proc.command}`)
        console.log('stdin:', proc.fd.stdin)
        console.log('stdout:', proc.fd.stdout)
        console.log('stderr:', proc.fd.stderr)
        console.log('tracked file handles:', proc.fd.fileHandles)
        console.groupEnd()
        
        return proc.fd
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
    
    this.log.debug('Debug globals available: ecmaos.kernel, ecmaos.processes(), ecmaos.fd(pid?), ecmaos.terminal, ecmaos.shell, ecmaos.fs')
  }
}
