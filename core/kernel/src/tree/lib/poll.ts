/**
 * `poll` over a set of `FileOperations` ends: wait until at least one is ready for what its
 * `PollTarget` asks for, or a timeout elapses.
 *
 * `@zenfs/linux`'s `wait_event` (`wait.ts`) only sleeps on a single `WaitQueue`. Waiting on several
 * fds at once -- the entire point of `poll(2)` -- needs racing N queues, which nothing in
 * `@zenfs/linux@0.4.0` provides (there is no `wait_event_any`). This module is that: the missing
 * half of U7, built on the public `WaitQueue`/`poll`/`poll_wait` surface so it upstreams cleanly
 * once `@zenfs/linux` grows real fds to poll.
 */

import { EPOLLIN, EPOLLOUT } from '@zenfs/linux'
import type { DeviceFile, FileOperations } from '@zenfs/linux'

export interface PollTarget {
  file: DeviceFile
  ops: FileOperations
  /** The events this target is polled for, e.g. `EPOLLIN` for a read, `EPOLLOUT` for a write */
  events: number
}

export interface PollResult {
  target: PollTarget
  /** The subset of `target.events` (plus anything else the op reported) that is ready */
  revents: number
}

/** What `target.ops.poll` reports right now, treating a missing `poll` as always-ready (§FileOperations doc). */
function readiness(target: PollTarget): number {
  return target.ops.poll?.(target.file) ?? (EPOLLIN | EPOLLOUT)
}

/**
 * Wait until at least one target is ready for its requested events, or `timeoutMs` elapses.
 * @param timeoutMs `undefined` waits forever; `0` polls once without waiting
 * @returns the targets that are ready (empty on timeout)
 */
export async function pollAll(targets: PollTarget[], timeoutMs?: number): Promise<PollResult[]> {
  const ready = () => targets
    .map(target => ({ target, revents: readiness(target) & target.events }))
    .filter(result => result.revents !== 0)

  const immediate = ready()
  if (immediate.length > 0 || timeoutMs === 0) return immediate

  const { promise, resolve } = Promise.withResolvers<void>()
  const stops = targets
    .map(target => target.ops.poll_wait?.(target.file)?.wait_with(resolve))
    .filter((stop): stop is () => void => !!stop)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = timeoutMs === undefined
    ? new Promise<void>(() => {})
    : new Promise<void>(res => { timer = setTimeout(res, timeoutMs) })

  try {
    await Promise.race([promise, timeout])
  } finally {
    for (const stop of stops) stop()
    if (timer !== undefined) clearTimeout(timer)
  }

  return ready()
}
