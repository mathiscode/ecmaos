/**
 * The job-control shim: the process half of POSIX job control that `@zenfs/linux` does not have yet.
 *
 * Each op is named for the call it stands in for. Upstream has the terminal half (`tty.pgrp`,
 * `TIOCSPGRP`, `SIGTTIN`/`SIGTTOU`) but `SYS_setpgid` is a stub, `wait()` always blocks, and nothing
 * raises `SIGCHLD`. REMOVAL: when upstream lands `setpgid`, `waitpid(WNOHANG)` and `SIGCHLD`, delete
 * this file, drop the `proc_*` registrations in `main-thread-syscalls.ts`, and point the worker
 * wrappers in `node.mjs` at the real syscalls.
 *
 * A wait status is Linux-shaped: `(code & 0xff) << 8` for a normal exit, or the signal number in the
 * low 7 bits for a death by signal. `waitpid` returns `pid * 65536 + status` so a plain number crosses
 * the syscall boundary, and 0 when `WNOHANG` finds nothing ready.
 */

import { Process, execve, kill as zenfsKill, processes } from '@zenfs/linux'
import { bindContext, fs } from '@zenfs/core'
import type { Credentials } from '@zenfs/core'
import { Errno } from 'kerium'
import { setuidCredentials } from './process-credentials.ts'

const SIGCHLD = 17

/** Process group of each pid; a process with no entry is in its parent's group, as after `fork`. */
const groups = new Map<number, number>()

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
 * `^C`, `^\` and `^Z` are signals to the terminal's foreground process *group*, but the line discipline
 * names a single process. This makes such a signal, when it reaches a process that is its terminal's
 * foreground, go to the rest of the process's group, and to what it started, too: the other stages of a
 * pipeline, or what a forked subshell has run (without it the subshell dies and its `sleep` is left running). A signal
 * sent to the process by pid is not from the terminal, and stays with that one process.
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
}

/** `setpgid(2)`: `pid` 0 means the caller, `pgid` 0 means the target's own pid. */
export function setpgid(caller: Process, pid: number, pgid: number): number {
  const target = pid === 0 ? caller : processes.get(pid)
  if (!target || (target !== caller && target.parent !== caller)) throw fail(Errno.ESRCH, 'No such process')
  groups.set(target.pid, pgid === 0 ? target.pid : pgid)
  return 0
}

/**
 * `killpg(3)`: every live process in the group. Returns how many took the signal.
 *
 * With a `caller`, only the members it may signal (`mayKill`) get it, and if there are members but none
 * of them is the caller's to signal, that is `EPERM` rather than a group that does not exist.
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
        return stopped.pid * 65536 + encodeStopped(SIGTSTP)
      }
    }
    if (nohang) return 0
    // `stopped` is a plain flag with no event behind it, so a wait that watches for stops has to poll.
    const exits = children.map(async child => { await child.exited })
    if (untraced) await Promise.race([...exits, new Promise(resolve => setTimeout(resolve, 25))])
    else await Promise.race(exits)
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
  pgid?: number
  /** Run the child as this user instead of as the caller: what `login` does for the shell it starts (callers must be root) */
  credentials?: Credentials
  /** A terminal to make the child's controlling terminal and foreground, with the keyboard routed to it for as long as it runs. */
  terminal?: { zfsTty: Process['tty'] | undefined, attachInput(): () => void }
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
    for (const [target, source] of Object.entries(options.fds ?? {})) {
      const handle = parent.context.descriptors.get(source)
      if (!handle) throw fail(Errno.EBADF, `Bad file descriptor: ${source}`)
      if (child.context.descriptors.has(Number(target))) fs.closeSync.call(child.context, Number(target))
      child.context.descriptors.set(Number(target), handle.ref())
    }
    if (options.pgid !== undefined) groups.set(child.pid, options.pgid === 0 ? child.pid : options.pgid)
    await execve(child, command, argv, env)
    if (options.terminal?.zfsTty) {
      const tty = options.terminal.zfsTty
      const previous = tty.foreground
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
    throw error
  }
  void child.exited.then(() => {
    if (parent.code === undefined) try { parent.kill(SIGCHLD) } catch { /* nobody is listening */ }
  })
  return child
}
