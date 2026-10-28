/**
 * File change notification for programs, which `inotifywait` uses: `watch_add(path, recursive)` starts watching a file
 * or a directory and answers an id, `watch_next(ids, timeoutMs, path)` waits until any of the watches (a JSON array of
 * ids) has seen something and writes what they have seen to `path` as JSON (`[{ id, type, name }]`, the name relative to
 * what is watched), and `watch_rm(id)` stops. A process's watches end with it.
 *
 * The events are zenfs's: `rename` where something is made, removed or renamed, and `change` where a file is written.
 * A program's `write`, `ftruncate` and `truncate` reach the file without passing the code that says so, so they are
 * wrapped here to say it too. There is no event for a read, an open, a close or a change of mode or owner.
 */

import { fs } from '@zenfs/core'
import { fromFD } from '@zenfs/core/vfs/file'
import { emitChange } from '@zenfs/core/vfs/watchers'
import { define_syscall, syscalls, WaitQueue, wait_event_any, type Process } from '@zenfs/linux'
import { withErrno } from 'kerium'

declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    watch_add(path: string, recursive: number): number
    watch_next(ids: string, timeoutMs: number, path: string): number
    watch_rm(id: number): number
  }
}

interface Watch { owner: number, close(): void, events: { type: string, name: string }[], queue: WaitQueue }

const watches = new Map<number, Watch>()
let nextId = 1
/** The most events a watch keeps before it drops the oldest, as inotify's queue overflows */
const QUEUE_LIMIT = 16384

function remove(id: number): void {
  const watch = watches.get(id)
  if (!watch) return
  watch.close()
  watches.delete(id)
}

/** Says a descriptor's file changed, after the call that changed it */
function wrapWrites(): void {
  for (const name of ['write', 'ftruncate'] as const) {
    const original = syscalls.get(name) as unknown as (proc: Process, fd: number, ...rest: unknown[]) => unknown
    if (!original) continue
    syscalls.set(name, (async (proc: Process, fd: number, ...rest: unknown[]) => {
      const result = await original(proc, fd, ...rest)
      if (watches.size) {
        try {
          const handle = fromFD(proc.context, fd)
          if (handle.path && !handle.path.startsWith('/dev/') && !handle.path.startsWith('/proc/')) emitChange(proc.context, 'change', handle.path)
        } catch { /* not a file */ }
      }
      return result
    }) as never)
  }
  const truncate = syscalls.get('truncate') as unknown as (proc: Process, path: string, length: number) => unknown
  if (truncate) {
    syscalls.set('truncate', (async (proc: Process, path: string, length: number) => {
      const result = await truncate(proc, path, length)
      if (watches.size) emitChange(proc.context, 'change', path)
      return result
    }) as never)
  }
}

let installed = false
export function installFsWatch(writeResult: (proc: Process, path: string, text: string) => Promise<void>): void {
  if (installed) return
  installed = true
  wrapWrites()

  define_syscall('watch_add', (proc: Process, path: string, recursive: number) => {
    // what cannot be seen cannot be watched
    fs.statSync.call(proc.context, path)
    const id = nextId++
    const queue = new WaitQueue()
    const events: Watch['events'] = []
    const watcher = fs.watch.call(proc.context, path, {}, (type, name) => {
      const relative = String(name ?? '')
      // zenfs tells a directory's watchers about everything below it; inotify tells them about their own entries
      if (!recursive && relative.includes('/')) return
      events.push({ type, name: relative })
      if (events.length > QUEUE_LIMIT) events.splice(0, events.length - QUEUE_LIMIT)
      queue.wake_up()
    })
    watches.set(id, { owner: proc.pid, close: () => watcher.close(), events, queue })
    void proc.exited?.then(() => remove(id))
    return id
  })

  define_syscall('watch_next', async (proc: Process, idsJson: string, timeoutMs: number, path: string) => {
    const ids = JSON.parse(idsJson) as number[]
    const chosen = ids.map(id => [id, watches.get(id)] as const)
    if (!chosen.length || chosen.some(([, watch]) => !watch || watch.owner !== proc.pid)) throw withErrno('EBADF')
    const ready = () => chosen.some(([, watch]) => watch!.events.length > 0)
    if (!ready()) await wait_event_any(chosen.map(([, watch]) => watch!.queue), ready, proc, timeoutMs)
    const taken = chosen.flatMap(([id, watch]) => watch!.events.splice(0).map(event => ({ id, ...event })))
    await writeResult(proc, path, JSON.stringify(taken))
    return taken.length
  })

  define_syscall('watch_rm', (proc: Process, id: number) => {
    const watch = watches.get(id)
    if (!watch || watch.owner !== proc.pid) throw withErrno('EBADF')
    remove(id)
    return 0
  })
}
