/**
 * The service manager in `/sbin/init`: what systemd does for `.service` units, on top of the inittab init. At boot it
 * starts the units the default target wants, and the SysV scripts with start links in the runlevel's `rcN.d`, ordered
 * by `After=`/`Before=`; it starts and stops units when `systemctl` asks, restarts them as `Restart=` says, publishes
 * their state in `/run/systemd/state.json`, and stops them all, last started first, when the system goes down.
 *
 * Each `Exec*=` process starts in a process group of its own, which stands in for the unit's control group: stopping a
 * unit sends `KillSignal=` to the group, then `SIGKILL` after `TimeoutStopSec=`. A unit whose output goes to the journal
 * runs under `systemd-cat -t IDENT`, which logs each line it prints to `/dev/log`; the manager's own messages about a
 * unit go there as `init[1]`. `Type=notify` is taken as `simple` (there is no notify socket), and `Type=forking` finds
 * its main process through `PIDFile=` when there is one.
 *
 * Waiting for a process is done through {@link ServiceManager.exited}, which init calls for every child it reaps;
 * nothing here waits on its own. No Node built-ins.
 */

import { loadUnits, RUN_DIR, RUNLEVEL_TARGETS, STATE_FILE, splitCommand, startOrder, sysvEnabledIn, parseEnvironmentFile, unitName, wantedByLinks } from './unit-file.js'
import type { ExecLine, Unit, UnitReader, UnitState } from './unit-file.js'

export interface ServiceAccount { name: string, uid: number, gid: number, groups: number[], home: string, shell: string }

export interface ServiceHost {
  reader: UnitReader
  /** Starts a process in a new process group; resolves to its pid */
  spawn(argv: string[], options: { cwd: string, env: Record<string, string>, credentials?: { uid: number, gid: number, groups: number[] } }): Promise<number>
  killpg(pgid: number, signal: number): Promise<void>
  kill(pid: number, signal: number): Promise<void>
  /** Whether a process still exists */
  alive(pid: number): boolean
  writeFile(path: string, text: string): void
  mkdir(path: string): void
  account(name: string): ServiceAccount | undefined
  groupId(name: string): number | undefined
  /** A message for the system log, from init */
  syslog(message: string): void
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}

export interface ExitStatus { code?: number, signal?: number }

export interface ServiceRequest { id: string, action: string, units: string[], signal?: number, uid?: number }
export interface ServiceReply { id: string, ok: boolean, errors: string[] }

const SIGKILL = 9
const SIGTERM = 15
const SIGNAL_NAMES: Record<number, string> = { 1: 'HUP', 2: 'INT', 3: 'QUIT', 4: 'ILL', 6: 'ABRT', 8: 'FPE', 9: 'KILL', 10: 'USR1', 11: 'SEGV', 12: 'USR2', 13: 'PIPE', 14: 'ALRM', 15: 'TERM' }
const STATUS_NAMES: Record<number, string> = { 0: 'SUCCESS', 1: 'FAILURE', 2: 'INVALIDARGUMENT', 3: 'NOTIMPLEMENTED', 4: 'NOPERMISSION', 5: 'NOTINSTALLED', 6: 'NOTCONFIGURED', 7: 'NOTRUNNING', 200: 'CHDIR', 203: 'EXEC', 217: 'USER', 216: 'GROUP' }
/** The signals a `simple` service ends by cleanly, as systemd counts them */
const CLEAN_SIGNALS = new Set([1, 2, 13, 15])
const SEARCH_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
/** As systemd's default `StartLimitBurst=` in `StartLimitIntervalSec=` */
const START_LIMIT = { burst: 5, intervalMs: 10_000 }

export const describeStatus = (status: ExitStatus): string =>
  status.signal !== undefined ? `code=killed, status=${status.signal}/${SIGNAL_NAMES[status.signal] ?? status.signal}` : `code=exited, status=${status.code}/${STATUS_NAMES[status.code ?? 0] ?? status.code}`

class Failure extends Error {
  constructor(message: string, readonly result: string, readonly status?: ExitStatus) { super(message) }
}

interface Runtime {
  unit: Unit
  state: UnitState
  /** The main process, while there is one */
  main?: number
  /** The processes of the unit's group to signal when it stops */
  group?: number
  /** Set while the unit is being stopped on purpose, so its main process exiting is not a failure */
  stopping: boolean
  restartTimer?: unknown
  /** Start times, for the start limit */
  starts: number[]
  /** The identifiers its output is logged under, for `journalctl -u` */
  identifiers: Set<string>
  /** The operation in progress, so a second request waits for it instead of racing it */
  busy?: Promise<void>
}

export class ServiceManager {
  private units = new Map<string, Unit>()
  private readonly runtime = new Map<string, Runtime>()
  private readonly waiters = new Map<number, (status: ExitStatus) => void>()
  /** Statuses of processes that exited before anyone asked to wait for them */
  private readonly early = new Map<number, ExitStatus>()
  /** The processes the manager started and has not yet seen end */
  private readonly own = new Set<number>()
  private readonly started: string[] = []
  private down = false

  constructor(private readonly host: ServiceHost) {}

  /** Reads the unit directories again, as `daemon-reload` does */
  reload(): void {
    this.units = loadUnits(this.host.reader)
    for (const [name, runtime] of this.runtime) {
      const unit = this.units.get(name)
      if (unit) runtime.unit = unit
    }
  }

  /** Starts what the runlevel's target wants; resolves once each has been started (or has failed) */
  async boot(level: string | undefined): Promise<void> {
    this.reload()
    this.host.mkdir(RUN_DIR)
    this.publish()
    // `systemctl set-default` links default.target; a runlevel init was asked for comes first
    const configured = this.host.reader.readlink('/etc/systemd/system/default.target')
    const target = level !== undefined ? RUNLEVEL_TARGETS[level] : configured ? configured.slice(configured.lastIndexOf('/') + 1) : 'graphical.target'
    const targets = target === 'graphical.target' ? ['multi-user.target', 'graphical.target', 'default.target'] : target ? [target] : []
    const wanted: Unit[] = []
    for (const unit of this.units.values()) {
      const byLink = !unit.sysv && wantedByLinks(this.host.reader, unit.name).some(name => targets.includes(name))
      const byRc = unit.sysv && sysvEnabledIn(this.host.reader, unit.name.replace(/\.service$/, ''), level && /^[2-5]$/.test(level) ? level : '3')
      if (byLink || byRc) wanted.push(unit)
    }
    // SysV scripts start in the order of their S numbers, then the ordering the units give
    const rcOrder = (unit: Unit) => {
      const file = this.host.reader.readdir(`/etc/rc${level && /^[2-5]$/.test(level) ? level : '3'}.d`).find(name => name.slice(3) === unit.name.replace(/\.service$/, ''))
      return file ? Number(file.slice(1, 3)) : 50
    }
    wanted.sort((a, b) => (a.sysv ? rcOrder(a) : 50) - (b.sysv ? rcOrder(b) : 50))
    for (const unit of startOrder(wanted)) {
      if (this.down) return
      await this.start(unit.name).catch(() => {})
    }
  }

  /** Stops every running unit, the last started first */
  async shutdown(): Promise<void> {
    this.down = true
    for (const runtime of this.runtime.values()) if (runtime.restartTimer !== undefined) this.host.clearTimer(runtime.restartTimer)
    const order = [...new Set([...this.started].reverse())]
    for (const name of order) {
      const runtime = this.runtime.get(name)
      if (runtime && ['active', 'activating', 'reloading'].includes(runtime.state.ActiveState)) await this.stop(name).catch(() => {})
    }
  }

  /** A child init reaped. True when it was one of the manager's */
  exited(pid: number, status: ExitStatus): boolean {
    const waiter = this.waiters.get(pid)
    if (waiter) { this.waiters.delete(pid); waiter(status); return true }
    for (const runtime of this.runtime.values()) {
      if (runtime.main === pid) { this.own.delete(pid); this.mainExited(runtime, status); return true }
    }
    if (this.own.has(pid)) { this.own.delete(pid); this.early.set(pid, status); return true }
    return false
  }

  /** Handles one request from `systemctl` */
  async handle(request: ServiceRequest): Promise<ServiceReply> {
    const errors: string[] = []
    if (request.action === 'daemon-reload' || request.action === 'daemon-reexec') {
      this.reload()
      this.publish()
      return { id: request.id, ok: true, errors }
    }
    this.reload()
    for (const raw of request.units) {
      const name = unitName(raw)
      try {
        switch (request.action) {
          case 'start': await this.start(name); break
          case 'stop': await this.stop(name); break
          case 'restart': await this.restart(name, false); break
          case 'try-restart': await this.restart(name, true); break
          case 'reload': await this.reloadUnit(name, false); break
          case 'reload-or-restart': await this.reloadUnit(name, true); break
          case 'kill': await this.killUnit(name, request.signal ?? SIGTERM); break
          case 'reset-failed': this.resetFailed(name); break
          default: throw new Failure(`Unknown operation ${request.action}.`, 'resources')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // what keeps a job from being queued at all is said as systemctl says it
        errors.push(error instanceof Failure && error.result === 'resources' && !message.startsWith('Failed') ? `Failed to ${request.action.replace(/-/g, ' ')} ${name}: ${message}` : message)
      }
    }
    return { id: request.id, ok: errors.length === 0, errors }
  }

  private runtimeOf(name: string): Runtime {
    let runtime = this.runtime.get(name)
    if (!runtime) {
      const unit = this.units.get(name)
      if (!unit) throw new Failure(this.host.reader.readlink(`/etc/systemd/system/${name}`) === '/dev/null' ? `Unit ${name} is masked.` : `Unit ${name} not found.`, 'resources')
      runtime = { unit, state: { ActiveState: 'inactive', SubState: 'dead', MainPID: 0, Result: 'success', NRestarts: 0 }, stopping: false, starts: [], identifiers: new Set() }
      this.runtime.set(name, runtime)
    }
    return runtime
  }

  /** Runs one operation on a unit at a time */
  private async serially(runtime: Runtime, operation: () => Promise<void>): Promise<void> {
    while (runtime.busy) await runtime.busy.catch(() => {})
    const busy = operation()
    runtime.busy = busy
    try { await busy } finally { if (runtime.busy === busy) runtime.busy = undefined }
  }

  private set(runtime: Runtime, active: UnitState['ActiveState'], sub: string, extra: Partial<UnitState> = {}): void {
    const was = runtime.state.ActiveState
    const now = this.host.now()
    runtime.state = { ...runtime.state, ActiveState: active, SubState: sub, ...extra }
    if (active === 'active' && was !== 'active') runtime.state.ActiveEnterTimestamp = now
    if ((active === 'inactive' || active === 'failed') && was !== active) runtime.state.InactiveEnterTimestamp = now
    this.publish()
  }

  /** Writes every unit's state for `systemctl` */
  publish(): void {
    const units: Record<string, UnitState & { Identifiers: string[], Description: string, FragmentPath: string, SysV: boolean }> = {}
    for (const [name, runtime] of this.runtime) {
      units[name] = { ...runtime.state, Identifiers: [...runtime.identifiers], Description: runtime.unit.description, FragmentPath: runtime.unit.path, SysV: runtime.unit.sysv }
    }
    try { this.host.writeFile(STATE_FILE, JSON.stringify({ units }) + '\n') } catch { /* /run is not there yet */ }
  }

  private label(unit: Unit): string {
    return unit.description && unit.description !== unit.name ? `${unit.name} - ${unit.description}` : unit.name
  }

  /** The environment, working directory and credentials a unit's processes get */
  private context(unit: Unit, extra: Record<string, string> = {}): { cwd: string, env: Record<string, string>, credentials?: { uid: number, gid: number, groups: number[] } } {
    const env: Record<string, string> = { PATH: SEARCH_PATH, LANG: 'C.UTF-8' }
    let credentials: { uid: number, gid: number, groups: number[] } | undefined
    let home = '/root'
    if (unit.user && unit.user !== 'root' && unit.user !== '0') {
      const account = /^\d+$/.test(unit.user) ? undefined : this.host.account(unit.user)
      const uid = account?.uid ?? (/^\d+$/.test(unit.user) ? Number(unit.user) : undefined)
      if (uid === undefined) throw new Failure(`${unit.name}: Failed to determine user credentials: No such process`, 'exit-code', { code: 217 })
      let gid = account?.gid ?? uid
      if (unit.group) {
        const found = /^\d+$/.test(unit.group) ? Number(unit.group) : this.host.groupId(unit.group)
        if (found === undefined) throw new Failure(`${unit.name}: Failed to determine group credentials: No such process`, 'exit-code', { code: 216 })
        gid = found
      }
      credentials = { uid, gid, groups: account?.groups ?? [] }
      home = account?.home ?? '/'
      Object.assign(env, { HOME: home, USER: account?.name ?? unit.user, LOGNAME: account?.name ?? unit.user, SHELL: account?.shell || '/bin/sh' })
    }
    for (const file of unit.environmentFiles) {
      const text = this.host.reader.readFile(file.path)
      if (text === undefined) {
        if (!file.optional) throw new Failure(`${unit.name}: Failed to load environment files: No such file or directory`, 'resources')
        continue
      }
      Object.assign(env, parseEnvironmentFile(text))
    }
    Object.assign(env, unit.environment, extra)
    let cwd = unit.workingDirectory ?? (credentials ? home : '/')
    if (cwd.startsWith('-')) cwd = cwd.slice(1)
    if (cwd === '~') cwd = home
    return { cwd, env, credentials }
  }

  /** The words of an `Exec*=` line, the program found on the search path as systemd finds it */
  private argvOf(unit: Unit, exec: ExecLine, env: Record<string, string>): string[] {
    const argv = splitCommand(exec.line, env)
    if (argv.length === 0) throw new Failure(`${unit.name}: Exec line is empty`, 'exit-code', { code: 203 })
    if (!argv[0]!.startsWith('/')) {
      const dir = SEARCH_PATH.split(':').find(candidate => this.host.reader.isExecutable(`${candidate}/${argv[0]}`))
      if (!dir) throw new Failure(`${unit.name}: Unable to locate executable '${argv[0]}': No such file or directory`, 'exit-code', { code: 203 })
      argv[0] = `${dir}/${argv[0]}`
    } else if (!this.host.reader.isExecutable(argv[0]!)) {
      throw new Failure(`${unit.name}: Unable to locate executable '${argv[0]}': No such file or directory`, 'exit-code', { code: 203 })
    }
    return argv
  }

  /** Starts one `Exec*=` process in a group of its own, its output to the journal unless the unit says otherwise */
  private async launch(runtime: Runtime, exec: ExecLine, extra: Record<string, string> = {}): Promise<number> {
    const { unit } = runtime
    const context = this.context(unit, extra)
    let argv = this.argvOf(unit, exec, context.env)
    if (unit.standardOutput === 'journal') {
      const identifier = unit.syslogIdentifier ?? argv[0]!.slice(argv[0]!.lastIndexOf('/') + 1)
      runtime.identifiers.add(identifier)
      argv = ['/bin/systemd-cat', '-t', identifier, '--', ...argv]
    }
    let pid: number
    try {
      pid = await this.host.spawn(argv, context)
    } catch (error) {
      throw new Failure(`${unit.name}: Failed to execute ${argv[argv[0] === '/bin/systemd-cat' ? 4 : 0]}: ${error instanceof Error ? error.message : String(error)}`, 'exit-code', { code: 203 })
    }
    this.own.add(pid)
    return pid
  }

  /** Resolves when `pid` exits, or with undefined after `ms` */
  private waitFor(pid: number, ms = Infinity): Promise<ExitStatus | undefined> {
    const early = this.early.get(pid)
    if (early) { this.early.delete(pid); return Promise.resolve(early) }
    return new Promise(resolve => {
      let timer: unknown
      this.waiters.set(pid, status => { this.own.delete(pid); if (timer !== undefined) this.host.clearTimer(timer); resolve(status) })
      if (ms !== Infinity) timer = this.host.setTimer(() => { this.waiters.delete(pid); resolve(undefined) }, ms)
    })
  }

  /** Runs `Exec*=` lines one after another, each to completion; a failure not marked `-` stops them */
  private async runAll(runtime: Runtime, lines: ExecLine[], extra: Record<string, string> = {}, timeoutMs = Infinity): Promise<void> {
    for (const exec of lines) {
      const pid = await this.launch(runtime, exec, extra)
      const status = await this.waitFor(pid, timeoutMs)
      if (status === undefined) {
        await this.host.killpg(pid, SIGKILL).catch(() => {})
        if (!exec.ignoreFailure) throw new Failure(`${runtime.unit.name}: Control process timed out`, 'timeout')
        continue
      }
      if ((status.code ?? 0) !== 0 || status.signal !== undefined) {
        if (!exec.ignoreFailure) throw new Failure(`${runtime.unit.name}: Control process exited, ${describeStatus(status)}`, status.signal !== undefined ? 'signal' : 'exit-code', status)
      }
    }
  }

  async start(name: string): Promise<void> {
    const runtime = this.runtimeOf(name)
    await this.serially(runtime, () => this.doStart(runtime))
    if (runtime.state.ActiveState === 'failed') throw new Failure(`Job for ${name} failed because the control process exited with error code.\nSee "systemctl status ${name}" and "journalctl -xeu ${name}" for details.`, runtime.state.Result)
  }

  private async doStart(runtime: Runtime): Promise<void> {
    const { unit } = runtime
    if (['active', 'reloading'].includes(runtime.state.ActiveState)) return
    if (runtime.restartTimer !== undefined) { this.host.clearTimer(runtime.restartTimer); runtime.restartTimer = undefined }
    const refusing = unit.warnings.find(warning => warning.endsWith('Refusing.'))
    if (refusing) {
      this.host.syslog(`${unit.name}: ${refusing}`)
      this.set(runtime, 'failed', 'failed', { Result: 'resources' })
      return
    }
    const now = this.host.now()
    runtime.starts = runtime.starts.filter(at => now - at < START_LIMIT.intervalMs)
    if (runtime.starts.length >= START_LIMIT.burst) {
      this.host.syslog(`${unit.name}: Start request repeated too quickly.`)
      this.host.syslog(`${unit.name}: Failed with result 'start-limit-hit'.`)
      this.host.syslog(`Failed to start ${this.label(unit)}.`)
      this.set(runtime, 'failed', 'failed', { Result: 'start-limit-hit' })
      return
    }
    runtime.starts.push(now)

    for (const dependency of [...unit.requires, ...unit.wants]) {
      if (!this.units.has(dependency) || dependency === unit.name) continue
      try { await this.start(dependency) } catch (error) {
        if (unit.requires.includes(dependency)) {
          this.host.syslog(`Dependency failed for ${this.label(unit)}.`)
          this.set(runtime, 'failed', 'failed', { Result: 'dependency' })
          return
        }
        void error
      }
    }

    if (!this.started.includes(unit.name)) this.started.push(unit.name)
    this.host.syslog(`Starting ${this.label(unit)}...`)
    this.set(runtime, 'activating', 'start-pre', { Result: 'success', ExecMainCode: undefined, ExecMainStatus: undefined, ExecMainExitTimestamp: undefined, MainPID: 0 })
    runtime.stopping = false
    try {
      await this.runAll(runtime, unit.execStartPre)
      runtime.state.ExecMain = unit.execStart[0]?.line
      if (unit.type === 'oneshot') {
        this.set(runtime, 'activating', 'start')
        runtime.state.ExecMainStartTimestamp = this.host.now()
        await this.runAll(runtime, unit.execStart)
        runtime.state.ExecMainExitTimestamp = this.host.now()
        Object.assign(runtime.state, { ExecMainCode: 'exited', ExecMainStatus: 0 })
        await this.runAll(runtime, unit.execStartPost)
        if (unit.remainAfterExit) {
          this.set(runtime, 'active', 'exited')
          this.host.syslog(`Finished ${this.label(unit)}.`)
        } else {
          this.host.syslog(`${unit.name}: Deactivated successfully.`)
          this.host.syslog(`Finished ${this.label(unit)}.`)
          this.set(runtime, 'inactive', 'dead')
        }
        return
      }
      if (unit.type === 'forking') {
        this.set(runtime, 'activating', 'start')
        runtime.state.ExecMainStartTimestamp = this.host.now()
        const pid = await this.launch(runtime, unit.execStart[0]!)
        runtime.group = pid
        const status = await this.waitFor(pid)
        if ((status?.code ?? 0) !== 0 || status?.signal !== undefined) throw new Failure(`${unit.name}: Control process exited, ${describeStatus(status ?? {})}`, 'exit-code', status)
        const pidText = unit.pidFile ? this.host.reader.readFile(unit.pidFile) : undefined
        const main = pidText ? Number(pidText.trim()) : NaN
        if (Number.isInteger(main) && main > 0 && this.host.alive(main)) {
          runtime.main = main
          this.set(runtime, 'active', 'running', { MainPID: main })
        } else this.set(runtime, 'active', unit.remainAfterExit ? 'exited' : 'running')
        await this.runAll(runtime, unit.execStartPost)
        this.host.syslog(`Started ${this.label(unit)}.`)
        return
      }
      const pid = await this.launch(runtime, unit.execStart[0]!)
      runtime.main = pid
      runtime.group = pid
      runtime.state.ExecMainStartTimestamp = this.host.now()
      this.set(runtime, 'active', 'running', { MainPID: pid })
      // it may have ended while it was starting
      const early = this.early.get(pid)
      if (early) { this.early.delete(pid); this.mainExited(runtime, early) }
      else await this.runAll(runtime, unit.execStartPost)
      if (runtime.state.ActiveState === 'active') this.host.syslog(`Started ${this.label(unit)}.`)
    } catch (error) {
      const failure = error instanceof Failure ? error : new Failure(String(error), 'resources')
      this.host.syslog(failure.message)
      if (failure.status) {
        runtime.state.ExecMainExitTimestamp = this.host.now()
        Object.assign(runtime.state, failure.status.signal !== undefined ? { ExecMainCode: 'killed', ExecMainStatus: failure.status.signal } : { ExecMainCode: 'exited', ExecMainStatus: failure.status.code })
      }
      if (runtime.group) await this.host.killpg(runtime.group, SIGKILL).catch(() => {})
      runtime.main = undefined
      runtime.group = undefined
      this.host.syslog(`${unit.name}: Failed with result '${failure.result}'.`)
      this.host.syslog(`Failed to start ${this.label(unit)}.`)
      this.set(runtime, 'failed', 'failed', { Result: failure.result, MainPID: 0 })
    }
  }

  /** The main process ended without being asked to: the unit is done, failed, or to be started again */
  private mainExited(runtime: Runtime, status: ExitStatus): void {
    const { unit } = runtime
    runtime.main = undefined
    runtime.state.ExecMainExitTimestamp = this.host.now()
    Object.assign(runtime.state, status.signal !== undefined ? { ExecMainCode: 'killed', ExecMainStatus: status.signal } : { ExecMainCode: 'exited', ExecMainStatus: status.code ?? 0 }, { MainPID: 0 })
    if (runtime.stopping) { this.publish(); return }
    const clean = status.signal !== undefined ? CLEAN_SIGNALS.has(status.signal) : (status.code ?? 0) === 0
    const result = clean ? 'success' : status.signal !== undefined ? 'signal' : 'exit-code'
    this.host.syslog(`${unit.name}: Main process exited, ${describeStatus(status)}`)
    if (!clean) this.host.syslog(`${unit.name}: Failed with result '${result}'.`)
    const restart = !this.down && (unit.restart === 'always'
      || (unit.restart === 'on-success' && clean)
      || (unit.restart === 'on-failure' && !clean)
      || (unit.restart === 'on-abnormal' && status.signal !== undefined && !clean)
      || (unit.restart === 'on-abort' && status.signal !== undefined && !clean))
    void this.runAll(runtime, unit.execStopPost).catch(() => {})
    if (restart) {
      this.set(runtime, 'activating', 'auto-restart', { Result: result })
      runtime.restartTimer = this.host.setTimer(() => {
        runtime.restartTimer = undefined
        if (runtime.state.SubState !== 'auto-restart') return
        runtime.state.NRestarts++
        this.host.syslog(`${unit.name}: Scheduled restart job, restart counter is at ${runtime.state.NRestarts}.`)
        // the state is left as it is so the start does not take the unit for one already running
        this.set(runtime, 'inactive', 'dead')
        void this.start(unit.name).catch(() => {})
      }, unit.restartSec)
      return
    }
    if (clean) {
      this.host.syslog(`${unit.name}: Deactivated successfully.`)
      this.set(runtime, 'inactive', 'dead', { Result: 'success' })
    } else this.set(runtime, 'failed', 'failed', { Result: result })
  }

  async stop(name: string): Promise<void> {
    const runtime = this.runtimeOf(name)
    await this.serially(runtime, () => this.doStop(runtime))
  }

  private async doStop(runtime: Runtime): Promise<void> {
    const { unit } = runtime
    if (runtime.restartTimer !== undefined) {
      this.host.clearTimer(runtime.restartTimer)
      runtime.restartTimer = undefined
      this.set(runtime, 'inactive', 'dead')
      return
    }
    if (runtime.state.ActiveState === 'inactive' || runtime.state.ActiveState === 'failed') return
    runtime.stopping = true
    this.host.syslog(`Stopping ${this.label(unit)}...`)
    this.set(runtime, 'deactivating', 'stop')
    const main = runtime.main
    const extra: Record<string, string> = main ? { MAINPID: String(main) } : {}
    try { await this.runAll(runtime, unit.execStop, extra, unit.timeoutStopSec) } catch (error) { this.host.syslog(error instanceof Error ? error.message : String(error)) }
    if (main && this.host.alive(main)) {
      const ended = this.waitFor(main, unit.timeoutStopSec)
      await this.host.killpg(runtime.group ?? main, unit.killSignal).catch(() => this.host.kill(main, unit.killSignal).catch(() => {}))
      if (await ended === undefined) {
        this.host.syslog(`${unit.name}: State 'stop-sigterm' timed out. Killing.`)
        const killed = this.waitFor(main, 2000)
        await this.host.killpg(runtime.group ?? main, SIGKILL).catch(() => this.host.kill(main, SIGKILL).catch(() => {}))
        await killed
      }
    } else if (runtime.group) await this.host.killpg(runtime.group, unit.killSignal).catch(() => {})
    runtime.main = undefined
    runtime.group = undefined
    try { await this.runAll(runtime, unit.execStopPost, {}, unit.timeoutStopSec) } catch { /* logged above */ }
    runtime.stopping = false
    this.host.syslog(`${unit.name}: Deactivated successfully.`)
    this.host.syslog(`Stopped ${this.label(unit)}.`)
    this.set(runtime, 'inactive', 'dead', { MainPID: 0 })
  }

  private async restart(name: string, onlyIfActive: boolean): Promise<void> {
    const runtime = this.runtimeOf(name)
    if (onlyIfActive && runtime.state.ActiveState !== 'active') return
    await this.stop(name)
    // a restart is a fresh start: the failed state and the start limit's count of one go do not stop it
    await this.start(name)
  }

  private async reloadUnit(name: string, orRestart: boolean): Promise<void> {
    const runtime = this.runtimeOf(name)
    const { unit } = runtime
    if (unit.execReload.length === 0) {
      if (orRestart) return this.restart(name, false)
      throw new Failure(`Failed to reload ${name}: Job type reload is not applicable for unit ${name}.`, 'resources')
    }
    if (runtime.state.ActiveState !== 'active') {
      if (orRestart) return this.start(name)
      throw new Failure(`Failed to reload ${name}: Unit ${name} is not active.`, 'resources')
    }
    await this.serially(runtime, async () => {
      this.host.syslog(`Reloading ${this.label(unit)}...`)
      const sub = runtime.state.SubState
      this.set(runtime, 'reloading', 'reload')
      try {
        await this.runAll(runtime, unit.execReload, runtime.main ? { MAINPID: String(runtime.main) } : {})
        this.host.syslog(`Reloaded ${this.label(unit)}.`)
      } finally {
        this.set(runtime, 'active', sub)
      }
    })
  }

  private async killUnit(name: string, signal: number): Promise<void> {
    const runtime = this.runtimeOf(name)
    if (!runtime.group && !runtime.main) throw new Failure(`Failed to kill unit ${name}: No main process to kill`, 'resources')
    await this.host.killpg(runtime.group ?? runtime.main!, signal).catch(() => this.host.kill(runtime.main!, signal))
  }

  private resetFailed(name: string): void {
    const runtime = this.runtime.get(name)
    if (!runtime) return
    runtime.starts = []
    if (runtime.state.ActiveState === 'failed') this.set(runtime, 'inactive', 'dead', { Result: 'success' })
  }
}
