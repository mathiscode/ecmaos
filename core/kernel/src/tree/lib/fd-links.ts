/**
 * `open`/`stat` of `/dev/fd/N`, `/dev/std{in,out,err}` and `/proc/self/fd/N` as a `dup` of the caller's own
 * descriptor, which is what those names are on Linux.
 *
 * Procfs already serves `/proc/<pid>/fd/N` as a symlink, but to `handle.path`, and a path cannot name
 * everything a descriptor can: a pipe's is `/3.w` on a pipefs that is never mounted, so following the
 * link ended in `EACCES`. Linux does not follow these, it reopens the same object ("magic links");
 * here the equivalent is to resolve the name to a descriptor number before the path is walked.
 *
 * Deliberately a `dup`, not a reopen: the two share a file offset and status flags. For the things
 * these names are used with (a pipe, a terminal, a redirected file being appended to) that is
 * indistinguishable, and `O_TRUNC` on a redirected file is not honored.
 */

import { syscalls } from '@zenfs/linux'
import type { Process } from '@zenfs/linux'

const NAMED: Record<string, number> = { '/dev/stdin': 0, '/dev/stdout': 1, '/dev/stderr': 2 }

/** The descriptor `path` names in process `pid`, or undefined when it is an ordinary path. */
export function fdLinkTarget(path: string, pid: number): number | undefined {
  if (path in NAMED) return NAMED[path]
  const match = /^(?:\/dev\/fd|\/proc\/(self|\d+)\/fd)\/(\d+)\/?$/.exec(path)
  if (!match) return undefined
  if (match[1] && match[1] !== 'self' && Number(match[1]) !== pid) return undefined
  return Number(match[2])
}

let installed = false

type Handler = (proc: Process, ...args: unknown[]) => number | bigint | void | Promise<number | bigint | void>

/** Each path syscall, and the descriptor syscall that answers it for a descriptor-named path. */
const BY_DESCRIPTOR = { open: 'dup', stat: 'fstat' } as const

/** Wraps `open` and `stat` so the names above reach the caller's own descriptor table. Idempotent. */
export function installFdLinks(): void {
  if (installed) return
  installed = true

  for (const [name, byFd] of Object.entries(BY_DESCRIPTOR)) {
    const path = syscalls.get(name as 'open') as Handler | undefined
    const fd = syscalls.get(byFd as 'dup') as Handler | undefined
    if (!path || !fd) continue

    syscalls.set(name as 'open', ((proc: Process, target: string, ...rest: unknown[]) => {
      const number = typeof target === 'string' ? fdLinkTarget(target, proc.pid) : undefined
      return number !== undefined ? fd(proc, number) : path(proc, target, ...rest)
    }) as never)
  }
}
