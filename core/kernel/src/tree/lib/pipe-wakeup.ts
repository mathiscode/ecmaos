/**
 * Wakes a pipe's sleepers when one of its ends closes.
 *
 * `@zenfs/linux` wakes a pipe's wait queue only when data moves, so a reader already blocked on an
 * empty pipe never learns that the last writer went away and sleeps forever instead of seeing EOF.
 * Whether a pipeline hangs then depends on whether the consumer reached its `read` before the
 * producer exited, which under load it sometimes does. Linux wakes readers when the last writer closes
 * (`pipe_release`); this does the equivalent by waking the pipe on every `close` and on process exit,
 * which is safe because a woken reader just looks again.
 *
 * REMOVAL: delete when upstream wakes the queue itself.
 */

import { Process, syscalls } from '@zenfs/linux'
import { pipefs } from '@zenfs/linux/fs/pipe'

let installed = false

type Handler = (proc: Process, ...args: unknown[]) => number | bigint | void | Promise<number | bigint | void>
type Wakeable = { pipe: { wait: { wake_up(): void } } }

/** The pipes referred to by these descriptors, for the ones that are pipe ends. */
function pipesOf(handles: Iterable<{ fs?: unknown, internalPath?: string }>): Wakeable[] {
  const found: Wakeable[] = []
  for (const handle of handles) {
    if (handle.fs !== pipefs || !handle.internalPath) continue
    const end = (pipefs as unknown as { _end(path: string): Wakeable | undefined })._end(handle.internalPath)
    if (end) found.push(end)
  }
  return found
}

const wake = (pipes: Wakeable[]) => { for (const { pipe } of pipes) pipe.wait.wake_up() }

/** Idempotent. */
export function installPipeWakeup(): void {
  if (installed) return
  installed = true

  for (const name of ['close', 'dup2', 'dup3'] as const) {
    const original = syscalls.get(name as 'close') as Handler | undefined
    if (!original) continue
    syscalls.set(name as 'close', (async (proc: Process, ...args: unknown[]) => {
      // `dup2`/`dup3` close their target implicitly, which is the descriptor named second.
      const fd = Number(name === 'close' ? args[0] : args[1])
      const handle = proc.context.descriptors.get(fd)
      const pipes = handle ? pipesOf([handle as never]) : []
      try {
        return await original(proc, ...args)
      } finally {
        wake(pipes)
      }
    }) as never)
  }

  const exit = Process.prototype.exit
  Process.prototype.exit = function (this: Process, ...args: Parameters<typeof exit>) {
    const pipes = pipesOf(this.context.descriptors.values() as never)
    try {
      return exit.apply(this, args)
    } finally {
      wake(pipes)
    }
  }
}
