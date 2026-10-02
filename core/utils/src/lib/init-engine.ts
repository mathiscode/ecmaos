/**
 * What `/sbin/init` does, apart from how it reaches the system: reads `/etc/inittab`, runs its
 * entries in BusyBox's order, restarts `respawn` entries when they exit, reaps everything else, and
 * re-reads the file on `SIGHUP`.
 *
 * Order: every `sysinit` entry (one at a time, each waited for), every `wait` entry the same way,
 * then {@link InitHost.booted}, then every `once` entry and every `respawn` entry started.
 *
 * The program supplies a {@link InitHost} over real syscalls; the tests supply one over a fake
 * clock. No Node built-ins.
 */

import { DEFAULT_BACKOFF, DEFAULT_INITTAB, RespawnTracker, entryKey, parseInittab } from './inittab.js'
import type { BackoffOptions, InitEntry } from './inittab.js'

export interface InitHost {
  /** The text of `/etc/inittab`, or `undefined` when there is no such file. */
  readInittab(): string | undefined
  /** Starts the entry's command and resolves to its pid. Rejects when it cannot be started. */
  spawn(entry: InitEntry): Promise<number>
  /**
   * Blocks until a child has exited (resolving to its pid, which is then reaped), `timeoutMs` has
   * passed (a negative number waits for ever), or a signal arrived. Resolves to 0 for the last two.
   */
  wait(timeoutMs: number): Promise<number>
  /** The signals that arrived since the last call, by name without the `SIG` prefix. */
  takeSignals(): string[]
  /** Pauses, for when waiting itself fails. */
  sleep(ms: number): Promise<void>
  now(): number
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** Called once the `sysinit` and `wait` entries are done. */
  booted(): void | Promise<void>
}

export class InitEngine {
  private entries: InitEntry[] = []
  private readonly running = new Map<number, InitEntry>()
  private readonly pending = new Map<string, { entry: InitEntry, at: number }>()
  private readonly tracker: RespawnTracker
  private reloadRequested = false
  private stopped = false

  constructor(private readonly host: InitHost, backoff: BackoffOptions = DEFAULT_BACKOFF) {
    this.tracker = new RespawnTracker(backoff)
  }

  /** Reads the file and runs the entries that happen once. */
  async boot(): Promise<void> {
    this.entries = this.load()
    for (const entry of this.entries) if (entry.action === 'sysinit') await this.runAndWait(entry)
    for (const entry of this.entries) if (entry.action === 'wait') await this.runAndWait(entry)
    await this.host.booted()
    for (const entry of this.entries) if (entry.action === 'once') await this.start(entry)
    for (const entry of this.entries) if (entry.action === 'respawn') await this.start(entry)
  }

  /** The reaping loop. Returns only after {@link stop}. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const pid = await this.host.wait(this.nextTimeout())
        this.handleSignals()
        if (pid) this.exited(pid)
        if (this.reloadRequested) { this.reloadRequested = false; await this.reload() }
        await this.startDue()
      } catch (error) {
        this.host.log('error', `init: ${error instanceof Error ? error.message : String(error)}`)
        await this.host.sleep(1000)
      }
    }
  }

  stop(): void {
    this.stopped = true
  }

  /** Reads the file again. A new `respawn` entry is started; a removed one is no longer restarted. */
  async reload(): Promise<void> {
    const next = this.load()
    const wanted = new Set(next.filter(entry => entry.action === 'respawn').map(entryKey))
    for (const key of [...this.pending.keys()]) {
      if (!wanted.has(key)) { this.pending.delete(key); this.tracker.forget(key) }
    }
    this.entries = next
    let started = 0
    for (const entry of next) {
      if (entry.action !== 'respawn') continue
      const key = entryKey(entry)
      if (this.isRunning(key) || this.pending.has(key)) continue
      await this.start(entry)
      started++
    }
    this.host.log('info', `init: read inittab again (${next.length} entries, ${started} started)`)
  }

  /** What is running and what is waiting to be restarted, for the tests. */
  snapshot(): { running: Array<[number, string]>, pending: Array<[string, number]> } {
    return {
      running: [...this.running].map(([pid, entry]) => [pid, entry.command]),
      pending: [...this.pending.values()].map(({ entry, at }) => [entry.command, at])
    }
  }

  private load(): InitEntry[] {
    let text = this.host.readInittab()
    if (text === undefined) {
      this.host.log('info', 'init: no /etc/inittab, using the default')
      text = DEFAULT_INITTAB
    }
    const { entries, errors } = parseInittab(text)
    for (const error of errors) this.host.log('warn', `init: inittab line ${error.line}: ${error.reason}`)
    return entries
  }

  private isRunning(key: string): boolean {
    for (const entry of this.running.values()) if (entryKey(entry) === key) return true
    return false
  }

  private isWanted(entry: InitEntry): boolean {
    const key = entryKey(entry)
    return this.entries.some(candidate => candidate.action === 'respawn' && entryKey(candidate) === key)
  }

  /** Starts an entry and remembers it. A command that cannot be started counts as one that exited at once. */
  private async start(entry: InitEntry): Promise<void> {
    const key = entryKey(entry)
    this.tracker.start(key, this.host.now())
    try {
      const pid = await this.host.spawn(entry)
      this.running.set(pid, entry)
    } catch (error) {
      this.host.log('error', `init: cannot start ${entry.command}: ${error instanceof Error ? error.message : String(error)}`)
      if (entry.action === 'respawn') this.schedule(entry)
    }
  }

  /** Runs an entry and waits for it, reaping whatever else exits meanwhile. */
  private async runAndWait(entry: InitEntry): Promise<void> {
    let pid: number
    try {
      pid = await this.host.spawn(entry)
    } catch (error) {
      this.host.log('error', `init: cannot start ${entry.command}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (;;) {
      const reaped = await this.host.wait(-1)
      this.handleSignals()
      if (reaped === pid) return
      if (reaped) this.exited(reaped)
    }
  }

  /** A child exited and is already reaped. Restarts it later when it is a `respawn` entry still in the file. */
  private exited(pid: number): void {
    const entry = this.running.get(pid)
    if (!entry) return // an orphan adopted from a process that exited, or something already forgotten
    this.running.delete(pid)
    if (entry.action === 'respawn' && this.isWanted(entry)) this.schedule(entry)
  }

  private schedule(entry: InitEntry): void {
    const key = entryKey(entry)
    const delay = this.tracker.exit(key, this.host.now())
    this.pending.set(key, { entry, at: this.host.now() + delay })
    if (delay > 0) this.host.log('warn', `init: ${entry.command} exited, starting it again in ${delay} ms`)
  }

  private nextTimeout(): number {
    let soonest = Infinity
    for (const { at } of this.pending.values()) soonest = Math.min(soonest, at)
    return soonest === Infinity ? -1 : Math.max(0, soonest - this.host.now())
  }

  private async startDue(): Promise<void> {
    const now = this.host.now()
    for (const [key, { entry, at }] of [...this.pending]) {
      if (at > now) continue
      this.pending.delete(key)
      if (this.isWanted(entry)) await this.start(entry)
    }
  }

  private handleSignals(): void {
    for (const name of this.host.takeSignals()) {
      if (name === 'HUP') this.reloadRequested = true
    }
  }
}
