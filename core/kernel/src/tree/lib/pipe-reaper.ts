/**
 * Frees pipes nothing refers to any more. `@zenfs/linux`'s pipe file system keeps every pipe it ever made (its table is
 * never pruned) and the kernel drops its own ends of a pipe from a descriptor table without closing them, so the vnode
 * reference stays held too. A command with three stages leaves about a dozen pipes behind, each with two inodes, and a
 * long run of commands slows down and grows by hundreds of megabytes. REMOVAL: delete when upstream frees a pipe on its
 * last close.
 */

import { processes } from '@zenfs/linux'
import { create_pipe, pipefs } from '@zenfs/linux/fs/pipe'
import { cacheOf } from '@zenfs/core/vfs/vcache'

type Internals = { pipes: Map<number, unknown>, unlinkSync(path: string): void }
type Context = Parameters<typeof create_pipe>[0]

/** Make a pipe, sweeping the dead ones every so often */
let created = 0
const SWEEP_EVERY = 32
/** Pipes found unreferenced by the last sweep; one is freed only when it is found so twice, in case an end was between tables */
let suspects = new Set<number>()

/** A pipe's ends are `/<id>.r` and `/<id>.w` */
const idOf = (path: string) => Number(/^\/(\d+)\./.exec(path)?.[1])

/** Frees every pipe that no descriptor anywhere refers to and that was already unreferenced at the previous sweep. @returns how many were freed */
export function reapPipes(): number {
  const internals = pipefs as unknown as Internals
  const open = new Set<number>()
  for (const proc of processes.values()) {
    for (const handle of proc.context.descriptors.values()) {
      if (handle.fs === pipefs && handle.internalPath) open.add(idOf(handle.internalPath))
    }
  }
  const cache = cacheOf(pipefs)
  const now = new Set<number>()
  let freed = 0
  for (const id of [...internals.pipes.keys()]) {
    if (open.has(id)) continue
    if (!suspects.has(id)) { now.add(id); continue }
    for (const path of [`/${id}.r`, `/${id}.w`]) {
      const node = cache.get(path)
      if (node) node.refs = 0
      cache.remove(path)
      try { internals.unlinkSync(path) } catch { /* already gone */ }
    }
    internals.pipes.delete(id)
    freed++
  }
  suspects = now
  return freed
}

/** `create_pipe`, with a sweep of the dead pipes every {@link SWEEP_EVERY} calls */
export function createPipe(context: Context, flags = 0) {
  if (++created % SWEEP_EVERY === 0) reapPipes()
  return create_pipe(context, flags)
}
