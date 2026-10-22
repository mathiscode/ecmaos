/**
 * The job-control shim: the process half of POSIX job control that `@zenfs/linux` lacks. Each op is named for the
 * call it stands in for. Upstream has `tty.pgrp`, `TIOCSPGRP` and `SIGTTIN`/`SIGTTOU`, but `SYS_setpgid` is a stub,
 * `wait()` always blocks and nothing raises `SIGCHLD`. REMOVAL: when upstream lands `setpgid`, `waitpid(WNOHANG)` and
 * `SIGCHLD`, delete this file, the `proc_*` registrations in `main-thread-syscalls.ts`, and point `node.mjs` at the
 * real syscalls.
 * A wait status is Linux-shaped: `(code & 0xff) << 8` for an exit, the signal number in the low 7 bits for a death by
 * signal. `waitpid` returns `pid * 65536 + status`, or 0 when `WNOHANG` finds nothing.
 */

import { Process, Thread, kill as zenfsKill, processes, syscalls } from '@zenfs/linux'
import { inheritUmask } from './umask-store.ts'
import { bindContext, fs } from '@zenfs/core'
import type { Credentials } from '@zenfs/core'
import { Errno } from 'kerium'
import { execveWhenFree } from './execve-retry.ts'
import { ttyPathOf } from './pty.ts'
import { setuidCredentials } from './process-credentials.ts'
import { finishTrace, tracerOf, traceProcess, untraceProcess } from './syscall-trace.ts'
import type { Tracer } from './syscall-trace.ts'

const SIGCHLD = 17
const SIGHUP = 1

/** Process group of each pid; a process with no entry is in its parent's group, as after `fork`. */
const groups = new Map<number, number>()

/** Session id of each pid; a process with no entry is in its parent's session, as after `fork`. */
const sessionIds = new Map<number, number>()

/** For each traced child: resolves once the end of its trace is written */
const traceFinished = new Map<number, Promise<void>>()

/** `waitpid` option bits, as on Linux */
export const WNOHANG = 1
export const WUNTRACED = 2
const SIGTSTP = 20
const SIGCONT = 18

/**
 * Children whose current stop has already been reported to a `WUNTRACED` wait. `killpg` clears a
 * child's mark when it continues it; a wait clears it once it sees the child running, for a `SIGCONT`
 * sent any other way.
 */
const stopReported = new WeakSet<Process>()

/** A stopped child's status: `0x7f` in the low byte, the stopping signal above it */
export function encodeStopped(signal: number): number { return (signal << 8) | 0x7f }

export function encodeStatus(code: number | undefined, signal: number | undefined): number {
  if (signal) return signal & 0x7f
  return ((code ?? 0) & 0xff) << 8
}

export function decodeStatus(status: number): { code?: number, signal?: number } {
  const signal = status & 0x7f
  return signal ? { signal } : { code: (status >> 8) & 0xff }
}

const fail = (errno: number, message: string) => Object.assign(new Error(message), { errno })

export function getpgid(proc: Process): number {
  return groups.get(proc.pid) ?? (proc.parent ? getpgid(proc.parent) : proc.pid)
}

/**
 * Who else a terminal signal to `proc` is for: its process group, and everything it started. The second part is
 * for a shell that gives each of its pipelines a group of its own, even a forked subshell that has no terminal
 * job control: the `sleep` it ran is in another group, but it is in front of the terminal all the same.
 */
function terminalPeers(proc: Process): Process[] {
  const pgid = getpgid(proc)
  const found = new Set<Process>()
  const walk = (parent: Process) => {
    for (const child of parent.children) {
      if (child.code !== undefined || found.has(child)) continue
      found.add(child)
      walk(child)
    }
  }
  walk(proc)
  for (const peer of processes.values()) if (peer !== proc && peer.code === undefined && getpgid(peer) === pgid) found.add(peer)
  found.delete(proc)
  return [...found]
}

/** The signals the terminal's line discipline raises for `^C`, `^\` and `^Z`. */
const TERMINAL_SIGNALS: ReadonlySet<number> = new Set([2, 3, 20])

/**
 * A signal that reaches a terminal's foreground process (`^C`, `^\`, `^Z`) is passed to the rest of its process group
 * and to what it started (other pipeline stages, a subshell's children). A signal sent by pid stays with that
 * process.
 */
export function shareGroupSignals(proc: Process): void {
  const deliver = proc.kill.bind(proc)
  let sharing = false
  proc.kill = (signal: Parameters<Process['kill']>[0]) => {
    const fromTerminal = !sharing && TERMINAL_SIGNALS.has(signal as number) && proc.tty?.foreground === proc
    // who is affected is read before the signal lands: a process that dies is forgotten, and its children
    // then fall back to a group of their own
    const peers = fromTerminal ? terminalPeers(proc) : []
    const delivered = deliver(signal)
    if (peers.length) {
      sharing = true
      try { for (const peer of peers) peer.kill(signal) } finally { sharing = false }
    }
    return delivered
  }
}

/** Drops a process's group entry once it has exited, so the table does not grow with every command. */
export function forgetGroup(pid: number): void {
  groups.delete(pid)
  // a session leader that exits gives up its terminal, so the next session leader can take it
  releaseSessionTty(pid)
  sessionIds.delete(pid)
}

export function getsid(proc: Process): number {
  return sessionIds.get(proc.pid) ?? (proc.parent ? getsid(proc.parent) : proc.pid)
}

/** The processes given their group and session entries by `installGroupExit` when init took them over */
const adopted = new Set<number>()

/**
 * Keeps process groups whole when a process exits, as Linux does:
 *  - its children, which init takes over, stay in the group and session they are in (a process with no entry here is
 *    in its parent's, which would otherwise become init's);
 *  - a terminal it was in front of stays with its group while any of the group is alive (upstream hands it to the
 *    parent, which may be init by then: a `^C` that ends a shell and the subshell it was waiting for at once moved Vim's
 *    terminal from Vim to init while Vim, which ignored the signal in `system()`, went on).
 */
export function installGroupExit(): void {
  const exit = Process.prototype.exit
  Process.prototype.exit = function (this: Process, ...args: Parameters<typeof exit>) {
    for (const child of this.children) {
      if (child.code !== undefined || groups.has(child.pid)) continue
      groups.set(child.pid, getpgid(child))
      if (!sessionIds.has(child.pid)) sessionIds.set(child.pid, getsid(child))
      adopted.add(child.pid)
    }
    const tty = this.tty
    const front = tty?.foreground === this
    const pgid = getpgid(this)
    try {
      return exit.apply(this, args)
    } finally {
      if (front && tty && !(tty.foreground && tty.foreground.code === undefined && getpgid(tty.foreground) === pgid)) {
        const members = [...processes.values()].filter(proc => proc !== this && proc.code === undefined && getpgid(proc) === pgid)
        const member = members.find(proc => proc.pid === pgid) ?? members[0]
        if (member) tty.foreground = member
      }
      if (adopted.delete(this.pid)) {
        groups.delete(this.pid)
        sessionIds.delete(this.pid)
      }
    }
  }
}

/** Puts a thread of `leader`'s process (`wali-threads.ts`), which has no parent, in the leader's group and session */
export function joinThreadGroup(thread: Process, leader: Process): void {
  groups.set(thread.pid, getpgid(leader))
  sessionIds.set(thread.pid, getsid(leader))
  void thread.exited.then(() => { groups.delete(thread.pid); sessionIds.delete(thread.pid) })
}

/** The terminal each session leader holds as its controlling terminal, by session id */
const sessionTtys = new Map<number, NonNullable<Process['tty']>>()

/** Which session a terminal is the controlling terminal of, if any */
export function ttySession(tty: Process['tty'] | undefined): number | undefined {
  if (!tty) return undefined
  for (const [sid, held] of sessionTtys) if (held === tty) return sid
}

function releaseSessionTty(sid: number): void {
  if (!sessionTtys.delete(sid)) return
  // what is left of the session no longer has a controlling terminal
  for (const proc of processes.values()) if (proc.code === undefined && getsid(proc) === sid) setTty(proc, null)
}

/** `Process.tty` is read-only to callers but is an ordinary field */
function setTty(proc: Process, tty: Process['tty'] | null): void {
  (proc as unknown as { tty: Process['tty'] | null }).tty = tty
}

/**
 * `setsid(2)`: the caller becomes the leader of a new session and of a new process group, with no controlling terminal.
 * A process group leader whose group has other members may not (`EPERM`), since the group would then span two sessions.
 */
export function setsid(proc: Process): number {
  // a group the caller leads and shares with others would then span two sessions; a group of one is simply left behind
  const leadsOthers = getpgid(proc) === proc.pid && [...processes.values()].some(peer => peer !== proc && peer.code === undefined && getpgid(peer) === proc.pid)
  if (leadsOthers) throw fail(Errno.EPERM, 'Operation not permitted')
  if (getsid(proc) === proc.pid && sessionIds.has(proc.pid)) throw fail(Errno.EPERM, 'Operation not permitted')
  sessionIds.set(proc.pid, proc.pid)
  groups.set(proc.pid, proc.pid)
  setTty(proc, null)
  void proc.exited.then(() => forgetGroup(proc.pid))
  return proc.pid
}

/**
 * `ioctl(fd, TIOCSCTTY, steal)`: a session leader with no controlling terminal takes `tty` as its own, and the terminal
 * is in front of the leader. A terminal another session holds is refused unless root asks to steal it.
 */
export function setControllingTty(proc: Process, tty: NonNullable<Process['tty']>, steal: boolean): number {
  const sid = getsid(proc)
  if (sid !== proc.pid || !sessionIds.has(proc.pid)) throw fail(Errno.EPERM, 'Operation not permitted')
  if (sessionTtys.has(sid)) {
    if (sessionTtys.get(sid) === tty) return 0
    throw fail(Errno.EPERM, 'Operation not permitted')
  }
  const owner = ttySession(tty)
  if (owner !== undefined && owner !== sid) {
    if (!steal || proc.context.credentials.euid !== 0) throw fail(Errno.EPERM, 'Operation not permitted')
    releaseSessionTty(owner)
  }
  sessionTtys.set(sid, tty)
  for (const peer of processes.values()) if (peer.code === undefined && getsid(peer) === sid) setTty(peer, tty)
  tty.foreground = proc
  return 0
}

/** What a terminal's first process is: leader of a new session and group, with `tty` as its controlling terminal */
export function startSession(proc: Process, tty: NonNullable<Process['tty']>): void {
  sessionIds.set(proc.pid, proc.pid)
  groups.set(proc.pid, proc.pid)
  setTty(proc, null)
  setControllingTty(proc, tty, true)
  void proc.exited.then(() => forgetGroup(proc.pid))
}

/**
 * `ioctl(fd, TIOCNOTTY)`: a session leader gives its controlling terminal up. What was in front of the terminal is hung
 * up and continued, as on Linux.
 */
export function dropControllingTty(proc: Process): number {
  const sid = getsid(proc)
  const tty = sessionTtys.get(sid)
  if (!tty || sid !== proc.pid) throw fail(Errno.ENOTTY, 'Inappropriate ioctl for device')
  const front = tty.foreground
  releaseSessionTty(sid)
  if (front && front !== proc && front.code === undefined) {
    try { front.kill(SIGHUP) } catch { /* already gone */ }
    try { front.kill(SIGCONT) } catch { /* already gone */ }
  }
  return 0
}

/** `setpgid(2)`: `pid` 0 means the caller, `pgid` 0 means the target's own pid. */
export function setpgid(caller: Process, pid: number, pgid: number): number {
  const target = pid === 0 ? caller : processes.get(pid)
  if (!target || (target !== caller && target.parent !== caller)) throw fail(Errno.ESRCH, 'No such process')
  groups.set(target.pid, pgid === 0 ? target.pid : pgid)
  return 0
}

/**
 * `killpg(3)`: signals every live process in the group and returns how many took it. With a `caller`, only members it
 * may signal (`mayKill`) get it; members but none signalable is `EPERM`.
 */
export function killpg(pgid: number, signal: number, caller?: Process): number {
  let count = 0
  let refused = 0
  for (const proc of [...processes.values()]) {
    if (proc.code !== undefined || getpgid(proc) !== pgid) continue
    if (caller && !mayKill(caller, proc)) { refused++; continue }
    if (signal === SIGCONT) stopReported.delete(proc)
    if (zenfsKill(proc.pid, signal)) count++
  }
  if (!count) throw fail(refused ? Errno.EPERM : Errno.ESRCH, refused ? 'Operation not permitted' : 'No such process group')
  return count
}

/** The signal each stopped process stopped with, which a `WUNTRACED` wait reports */
const stopSignals = new WeakMap<Process, number>()
/** For each stopped process, what lets its held syscall go on: `SIGCONT`, or its end */
const resumes = new WeakMap<Process, { promise: Promise<void>, resolve: () => void }>()

function resume(proc: Process): void {
  resumes.get(proc)?.resolve()
  resumes.delete(proc)
}

/**
 * Stopping, as Linux does it. The kernel's default action for `SIGSTOP`, `SIGTSTP`, `SIGTTIN` and `SIGTTOU` only marks
 * the process stopped, and a `SIGCONT` the program catches is only raised on its thread: here a stopped process's next
 * syscall waits until it is continued (a program that is computing is stopped when it next makes a call), `SIGCONT`
 * continues a process whether or not it catches the signal, and the parent hears of the stop by `SIGCHLD`. Idempotent.
 */
let stopsInstalled = false
export function installStops(): void {
  if (stopsInstalled) return
  stopsInstalled = true
  const kill = Process.prototype.kill
  Process.prototype.kill = function (this: Process, signal: Parameters<typeof kill>[0]) {
    const number = typeof signal === 'number' ? signal : undefined
    const wasStopped = this.stopped
    if (number === SIGCONT) this.stopped = false
    const result = kill.call(this, signal)
    if (!wasStopped && this.stopped) {
      stopSignals.set(this, number ?? SIGTSTP)
      const parent = this.parent
      if (parent && parent.code === undefined) try { parent.kill(SIGCHLD) } catch { /* nobody is listening */ }
    }
    if (wasStopped && (!this.stopped || this.code !== undefined)) resume(this)
    return result
  }
  // the method the thread runs each syscall the program makes through, which upstream keeps protected
  type Syscall = (this: Thread, message: unknown) => Promise<void>
  const prototype = Thread.prototype as unknown as { syscall: Syscall }
  const syscall = prototype.syscall
  prototype.syscall = async function (this: Thread, message: unknown) {
    await whenContinued(this.proc)
    return await syscall.call(this, message)
  }
  // A call that stopped the process (a `raise(SIGTSTP)`), or that was running when it stopped, comes back only once it
  // is continued, as on Linux: so a handler for `SIGCONT` has run before `raise` returns
  const threadOf = Thread.prototype as unknown as { wake(this: Thread, value: number): void }
  const wake = threadOf.wake
  threadOf.wake = function (this: Thread, value: number) {
    if (!this.proc.stopped || this.proc.code !== undefined) return wake.call(this, value)
    void whenContinued(this.proc).then(() => wake.call(this, value))
  }
  installBackgroundChecks()
}

/** Waits while `proc` is stopped: until a `SIGCONT`, or its end */
async function whenContinued(proc: Process): Promise<void> {
  while (proc.stopped && proc.code === undefined) {
    let held = resumes.get(proc)
    if (!held) {
      held = Promise.withResolvers<void>()
      resumes.set(proc, held)
      void proc.exited.then(() => resume(proc))
    }
    await held.promise
  }
}

const SIGTTIN = 21, SIGTTOU = 22
const TOSTOP = 0o400
const TCSETS = 0x5402, TCSETSW = 0x5403, TCSETSF = 0x5404, TIOCSPGRP = 0x5410

/**
 * A process in the background of its controlling terminal (its group is not the foreground's) that reads from it gets
 * `SIGTTIN`, and one that changes its settings, or writes to it with `TOSTOP` set, gets `SIGTTOU`, sent to its whole
 * group. Stopped by it (the default), the call goes on once the group is continued; with a handler, it fails with
 * EINTR. A process that ignores or blocks `SIGTTIN` reads EIO instead; one that ignores or blocks `SIGTTOU` just goes
 * ahead. Processes share their parent's group unless something set one (`setpgid`, `posix_spawn`), so this only ever
 * comes up under a shell that does job control.
 */
async function backgroundCheck(proc: Process, fd: unknown, signal: number, setting = false): Promise<void> {
  for (;;) {
    const tty = proc.tty
    if (!tty) return
    const handle = proc.context.descriptors.get(fd as number) as { path?: string } | undefined
    if (!handle || handle.path !== ttyPathOf(tty)) return
    const front = tty.foreground
    if (!front || front.code !== undefined || getpgid(front) === getpgid(proc)) return
    if (signal === SIGTTOU && !setting && !(tty.termios.lflag & TOSTOP)) return
    const state = signalStateOf(proc.pid)
    if ((state.ignored | state.blocked) & (1 << (signal - 1))) {
      if (signal === SIGTTIN) throw fail(Errno.EIO, 'Input/output error')
      return
    }
    try { killpg(getpgid(proc), signal) } catch { /* the group is gone */ }
    if (!proc.stopped) throw fail(Errno.EINTR, 'Interrupted system call')
    await whenContinued(proc)
  }
}

function installBackgroundChecks(): void {
  type Handler = (proc: Process, ...args: unknown[]) => unknown
  const wrap = (name: string, check: (proc: Process, args: unknown[]) => Promise<void>) => {
    const original = syscalls.get(name as never) as Handler | undefined
    if (!original) return
    syscalls.set(name as never, (async (proc: Process, ...args: unknown[]) => {
      await check(proc, args)
      return await original(proc, ...args)
    }) as never)
  }
  wrap('read', (proc, [fd]) => backgroundCheck(proc, fd, SIGTTIN))
  wrap('write', (proc, [fd]) => backgroundCheck(proc, fd, SIGTTOU))
  wrap('ioctl', async (proc, [fd, request]) => {
    if (request === TCSETS || request === TCSETSW || request === TCSETSF || request === TIOCSPGRP) await backgroundCheck(proc, fd, SIGTTOU, true)
  })
}

/** `waitpid(2)`: `pid` -1 for any child; `nohang` returns 0 rather than waiting. */
export async function waitpid(caller: Process, pid: number, flags: number | boolean): Promise<number> {
  const bits = typeof flags === 'boolean' ? (flags ? WNOHANG : 0) : flags
  const nohang = (bits & WNOHANG) !== 0
  const untraced = (bits & WUNTRACED) !== 0
  const children = [...caller.children].filter(child => pid < 0 || child.pid === pid)
  if (!children.length) throw fail(Errno.ECHILD, 'No such child')
  for (;;) {
    const ready = children.find(child => child.code !== undefined)
    if (ready) {
      // a traced child's last lines (its exit, the summary) are written before the parent hears it ended
      await traceFinished.get(ready.pid)
      const reaped = ready.pid
      const status = encodeStatus(ready.code, ready.killed_by)
      ready.reap()
      return reaped * 65536 + status
    }
    if (untraced) {
      // A stop is reported once, then not again until the child has run and stopped anew.
      for (const child of children) if (!child.stopped) stopReported.delete(child)
      const stopped = children.find(child => child.stopped && !stopReported.has(child))
      if (stopped) {
        stopReported.add(stopped)
        return stopped.pid * 65536 + encodeStopped(stopSignals.get(stopped) ?? SIGTSTP)
      }
    }
    if (nohang) return 0
    // A signal the caller catches ends the wait with EINTR, and nothing is reaped: the kernel woke the thread with
    // EINTR as it raised the signal, so a child reaped now would be lost to it. One that ended meanwhile (it is often
    // its SIGCHLD that woke the caller) is still there for the caller's next wait.
    const interrupts = caller.thread?.interrupts
    let stopInterrupt: (() => void) | undefined
    const interrupted = new Promise<void>(resolve => { stopInterrupt = caller.sigwait.wait_with(resolve) })
    // `stopped` is a plain flag with no event behind it, so a wait that watches for stops has to poll.
    const exits = children.map(async child => { await child.exited })
    try {
      if (untraced) await Promise.race([...exits, interrupted, new Promise(resolve => setTimeout(resolve, 25))])
      else await Promise.race([...exits, interrupted])
    } finally {
      stopInterrupt?.()
    }
    if (caller.thread && caller.thread.interrupts !== interrupts) throw fail(Errno.EINTR, 'Interrupted system call')
  }
}

/** What a caller may signal: anything if root, otherwise only its own user's processes. */
export function mayKill(caller: Process, target: Process): boolean {
  const { euid, uid } = caller.context.credentials
  if (euid === 0) return true
  const theirs = target.context.credentials
  return euid === theirs.uid || euid === theirs.suid || uid === theirs.uid || uid === theirs.suid
}

/** A process's hold on its terminal's keyboard, which it can give up while the terminal's own line editor runs. */
export interface TtyHold { suspend(): void, resume(): void }
const ttyHolds = new WeakMap<Process, TtyHold>()
export function ttyHoldOf(proc: Process): TtyHold | undefined { return ttyHolds.get(proc) }

export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string>
  /** child fd -> caller fd: the `dup2` file actions of `posix_spawn` */
  fds?: Record<string, number>
  /** `fds` is the child's whole table: it gets nothing else, not even the caller's 0 to 2 (`posix_spawn` closing one) */
  exactFds?: boolean
  /** The signals the child starts with ignored and blocked, as sigsets of signals 1 to 31 (see {@link signalStateOf}) */
  signals?: SignalState
  pgid?: number
  /**
   * Put the child's group in front of its terminal as it starts, as glibc's `POSIX_SPAWN_TCSETPGROUP` does: a shell
   * doing job control gives its foreground job the terminal this way, before the program can read it (a `tcsetpgrp`
   * after the spawn would come too late for a program that reads at once, which would stop on `SIGTTIN`).
   */
  foreground?: boolean
  /**
   * Start the child as the leader of a new session. With a `terminal` it is also given that terminal as its
   * controlling terminal, as `login` and `getty` do.
   */
  setsid?: boolean
  /**
   * Run the child as this user instead of as the caller: what `login` does for the shell it starts (callers must be
   * root)
   */
  credentials?: Credentials
  /**
   * A terminal to make the child's controlling terminal and foreground, with the keyboard routed to it for as long as
   * it runs.
   */
  terminal?: { zfsTty: Process['tty'] | undefined, attachInput(): () => void }
  /** Record the child's system calls (`strace`) */
  trace?: Tracer
}

/**
 * What a program's signals look like across `exec`: the ones it ignores stay ignored and its mask stays as it was
 * (a handler cannot survive, the code it named is gone). Each is a sigset of signals 1 to 31, bit `sig - 1`. A WALI
 * program hands them to the child it spawns (`proc_spawn`'s `signals`) or to the image it becomes
 * (`proc_set_sigstate`), and the program reads them when it starts (`proc_sigstate`).
 */
export interface SignalState {
  ignored: number
  blocked: number
}

const signalStates = new Map<number, SignalState>()

/** The signal state a process was started or exec'ed with; nothing ignored or blocked if it was not given one */
export function signalStateOf(pid: number): SignalState {
  return signalStates.get(pid) ?? { ignored: 0, blocked: 0 }
}

/** Records the signal state the process keeps across its next `exec`, for as long as it lives */
export function setSignalState(proc: Process, state: SignalState): void {
  const known = signalStates.has(proc.pid)
  signalStates.set(proc.pid, { ignored: state.ignored | 0, blocked: state.blocked | 0 })
  if (!known) void proc.exited.then(() => signalStates.delete(proc.pid))
}

/**
 * `posix_spawn(3)`: a child of `parent` with the descriptors in `fds` installed before it starts.
 * Raises `SIGCHLD` on the parent when the child exits.
 */
export async function spawnWithFds(parent: Process, command: string, argv: string[], env: Record<string, string>, options: SpawnOptions = {}): Promise<Process> {
  // `tty` is passed through even when it is null: left out, the constructor treats a parent with no
  // controlling terminal as one with the console, and `execve` would then make the child that
  // terminal's foreground process. A daemon started by init must stay off it.
  const cwd = options.cwd || parent.cwd
  // a program with the setuid bit runs with its owner's privileges, as it does when the shell starts it
  const credentials = options.credentials ?? setuidCredentials({ statSync: file => fs.statSync.call(parent.context, file) }, command.startsWith('/') ? command : `${cwd}/${command}`, parent.context.credentials)
  const child = new Process({
    parent, argv, env, cwd,
    // a context of its own, bound with the user's credentials; without one the process takes its parent's
    context: credentials ? bindContext.call(parent.context, { pwd: cwd, credentials }) : undefined,
    tty: options.terminal ? options.terminal.zfsTty ?? null : parent.tty
  })
  shareGroupSignals(child)
  inheritUmask(parent, child)
  // A traced process's children are traced too when the tracer follows them
  const inherited = tracerOf(parent.pid)
  const tracer = options.trace ?? (inherited?.options.follow ? inherited : undefined)
  if (tracer) traceProcess(child.pid, tracer)
  try {
    // Only 0 to 2 are handed on: a child that kept the caller's other descriptors would hold every
    // pipe end open and a reader downstream of it would never see EOF.
    for (const fd of [...child.context.descriptors.keys()]) {
      if (fd > 2) fs.closeSync.call(child.context, fd)
    }
    // A child with a parent inherits the parent's stdio rather than opening a console, so one given a
    // terminal (init's getty, whose own stdio is /dev/null) opens it for fds 0 to 2 here.
    if (options.terminal?.zfsTty) {
      for (const fd of [0, 1, 2]) if (child.context.descriptors.has(fd)) fs.closeSync.call(child.context, fd)
      for (let i = 0; i < 3; i++) fs.openSync.call(child.context, `/dev/${options.terminal.zfsTty.name}`, 'r+')
    }
    if (options.exactFds) {
      for (const fd of [...child.context.descriptors.keys()]) fs.closeSync.call(child.context, fd)
    }
    for (const [target, source] of Object.entries(options.fds ?? {})) {
      const handle = parent.context.descriptors.get(source)
      if (!handle) throw fail(Errno.EBADF, `Bad file descriptor: ${source}`)
      if (child.context.descriptors.has(Number(target))) fs.closeSync.call(child.context, Number(target))
      child.context.descriptors.set(Number(target), handle.ref())
    }
    if (options.pgid !== undefined) groups.set(child.pid, options.pgid === 0 ? child.pid : options.pgid)
    if (options.setsid) {
      sessionIds.set(child.pid, child.pid)
      groups.set(child.pid, child.pid)
      setTty(child, null)
      void child.exited.then(() => forgetGroup(child.pid))
    }
    if (options.signals) setSignalState(child, options.signals)
    // `execve` puts the program in front of its terminal; a child started in a group or session of its own is not
    // (Linux's exec never changes the foreground): whoever does job control moves it there with `tcsetpgrp`, or asks
    // for it with `foreground`
    const ownGroup = options.pgid !== undefined || options.setsid
    const front = child.tty?.foreground
    await execveWhenFree(child, command, argv, env)
    if (ownGroup && !options.foreground && child.tty && child.tty.foreground === child) child.tty.foreground = front
    if (options.terminal?.zfsTty) {
      const tty = options.terminal.zfsTty
      const previous = tty.foreground
      if (options.setsid) setControllingTty(child, tty, true)
      tty.foreground = child
      const terminal = options.terminal
      let release: (() => void) | undefined = terminal.attachInput()
      ttyHolds.set(child, {
        suspend: () => { release?.(); release = undefined },
        resume: () => { release ??= terminal.attachInput() }
      })
      void child.exited.then(() => {
        release?.()
        if (tty.foreground === child) tty.foreground = previous
      })
    }
  } catch (error) {
    child.dispose()
    groups.delete(child.pid)
    releaseSessionTty(child.pid)
    sessionIds.delete(child.pid)
    if (tracer) untraceProcess(child.pid)
    throw error
  }
  if (tracer) {
    const finished = child.exited.then(async () => {
      await finishTrace(child, tracer).catch(() => {})
      untraceProcess(child.pid)
    })
    traceFinished.set(child.pid, finished)
    void finished.then(() => traceFinished.delete(child.pid))
  }
  void child.exited.then(() => {
    if (parent.code === undefined) try { parent.kill(SIGCHLD) } catch { /* nobody is listening */ }
  })
  return child
}
