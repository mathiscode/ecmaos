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
import { fs } from '@zenfs/core'
import { Errno } from 'kerium'

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

/** `killpg(3)`: every live process in the group. Returns how many took the signal. */
export function killpg(pgid: number, signal: number): number {
  let count = 0
  for (const proc of [...processes.values()]) {
    if (proc.code !== undefined || getpgid(proc) !== pgid) continue
    if (signal === SIGCONT) stopReported.delete(proc)
    if (zenfsKill(proc.pid, signal)) count++
  }
  if (!count) throw fail(Errno.ESRCH, 'No such process group')
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

export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string>
  /** child fd -> caller fd: the `dup2` file actions of `posix_spawn` */
  fds?: Record<string, number>
  pgid?: number
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
  const child = new Process({ parent, argv, env, cwd: options.cwd || parent.cwd, tty: options.terminal ? options.terminal.zfsTty ?? null : parent.tty })
  try {
    // Only 0 to 2 are handed on: a child that kept the caller's other descriptors would hold every
    // pipe end open and a reader downstream of it would never see EOF.
    for (const fd of [...child.context.descriptors.keys()]) {
      if (fd > 2) fs.closeSync.call(child.context, fd)
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
      const release = options.terminal.attachInput()
      void child.exited.then(() => {
        release()
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
