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
    if (zenfsKill(proc.pid, signal)) count++
  }
  if (!count) throw fail(Errno.ESRCH, 'No such process group')
  return count
}

/** `waitpid(2)`: `pid` -1 for any child; `nohang` returns 0 rather than waiting. */
export async function waitpid(caller: Process, pid: number, nohang: boolean): Promise<number> {
  const children = [...caller.children].filter(child => pid < 0 || child.pid === pid)
  if (!children.length) throw fail(Errno.ECHILD, 'No such child')
  let ready = children.find(child => child.code !== undefined)
  if (!ready) {
    if (nohang) return 0
    ready = await Promise.race(children.map(async child => (await child.exited, child)))
  }
  const status = encodeStatus(ready.code, ready.killed_by)
  const reaped = ready.pid
  ready.reap()
  return reaped * 65536 + status
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
}

/**
 * `posix_spawn(3)`: a child of `parent` with the descriptors in `fds` installed before it starts.
 * Raises `SIGCHLD` on the parent when the child exits.
 */
export async function spawnWithFds(parent: Process, command: string, argv: string[], env: Record<string, string>, options: SpawnOptions = {}): Promise<Process> {
  const child = new Process({ parent, argv, env, cwd: options.cwd || parent.cwd })
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
