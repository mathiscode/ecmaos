/**
 * POSIX record locks (`fcntl` with `F_SETLK`, `F_SETLKW` and `F_GETLK`) for every process of the system. The C library's
 * calls reach them through the WALI host (`bin/wali-host.mjs`), which works out the range and names the file by its
 * device and inode; what is kept here is what Linux keeps.
 *
 * A lock belongs to a process (not to a thread, a descriptor or an open file), so a program's own locks never conflict,
 * and a forked child has none of its parent's. A process's locks on a file go where it closes any descriptor for the
 * file (the host says so, `release`), and where it ends. A range locked again is replaced, and ranges of one kind next to
 * each other are one. `F_SETLKW` waits until the range is free, gives up with EINTR when a signal arrives first, and
 * fails with EDEADLK when waiting would close a circle of processes each waiting on the next.
 *
 * Open file description locks (`F_OFD_*`) are not kept: they belong to an open file, which is released where its last
 * descriptor closes, and the host does not see that.
 */
import { define_syscall, thread_of, WaitQueue, wait_event_any, type Process } from '@zenfs/linux'
import { withErrno } from 'kerium'
import { leaderOf } from './wali-threads.ts'

declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    lock_op(op: number, key: string, type: number, start: number, end: number): number
  }
}

/** What `lock_op` is asked: look, take (1) or take and wait (2), or give up a file's locks */
const GET = 0, SET = 1, RELEASE = 3
const WRITE_LOCK = 1, UNLOCK = 2

/** A locked range of a file, [start, end) */
interface Lock { owner: number, type: number, start: number, end: number }
interface Request { key: string, type: number, start: number, end: number }

/** The locks on each file, by its device and inode */
const files = new Map<string, Lock[]>()
/** Woken whenever a lock is given up, for the processes waiting on one */
const changed = new WaitQueue()
/** What each process that is waiting for a lock waits for */
const waiting = new Map<number, Request>()
/** Processes whose end is waited for, to give up their locks */
const watched = new Set<number>()

/** The locks of other processes that keep `owner` from taking the range, the first by position first */
function blockers(owner: number, { key, type, start, end }: Request): Lock[] {
  return (files.get(key) ?? [])
    .filter(lock => lock.owner !== owner && lock.start < end && start < lock.end && (type === WRITE_LOCK || lock.type === WRITE_LOCK))
    .sort((a, b) => a.start - b.start)
}

/** Whether waiting for the range would end up waiting on the waiter itself: some process in the way is waiting on one that is in turn */
function circular(owner: number, request: Request): boolean {
  const seen = new Set<number>()
  const stack = blockers(owner, request).map(lock => lock.owner)
  while (stack.length) {
    const next = stack.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    const asked = waiting.get(next)
    if (!asked) continue
    for (const lock of blockers(next, asked)) {
      if (lock.owner === owner) return true
      stack.push(lock.owner)
    }
  }
  return false
}

/** Makes `owner`'s locks on the range what `type` says: its own locks there are cut away first, then the new one is put in and joined to its neighbours */
function place(owner: number, { key, type, start, end }: Request): void {
  const kept: Lock[] = []
  for (const lock of files.get(key) ?? []) {
    if (lock.owner !== owner || lock.end <= start || lock.start >= end) {
      kept.push(lock)
      continue
    }
    if (lock.start < start) kept.push({ ...lock, end: start })
    if (lock.end > end) kept.push({ ...lock, start: end })
  }
  if (type !== UNLOCK) kept.push({ owner, type, start, end })
  kept.sort((a, b) => a.start - b.start)
  const last = new Map<string, Lock>()
  const joined: Lock[] = []
  for (const lock of kept) {
    const name = `${lock.owner}:${lock.type}`
    const before = last.get(name)
    if (before && before.end >= lock.start) {
      before.end = Math.max(before.end, lock.end)
      continue
    }
    const copy = { ...lock }
    last.set(name, copy)
    joined.push(copy)
  }
  if (joined.length) files.set(key, joined)
  else files.delete(key)
  changed.wake_up()
}

/** Gives up every lock a process has, on one file or on all */
function drop(owner: number, key?: string): void {
  for (const name of key === undefined ? [...files.keys()] : [key]) place(owner, { key: name, type: UNLOCK, start: 0, end: Infinity })
}

async function lock(proc: Process, op: number, key: string, type: number, start: number, last: number): Promise<number> {
  const leader = leaderOf(proc)
  const owner = leader.pid
  if (op === RELEASE) {
    drop(owner, key)
    return 0
  }
  const request: Request = { key, type, start, end: last < 0 ? Infinity : last }
  if (op === GET) {
    const [first] = blockers(owner, request)
    const answer = new DataView(thread_of(proc).region.buffer, thread_of(proc).region.byteOffset)
    answer.setInt32(0, first ? first.type : UNLOCK, true)
    answer.setBigInt64(8, BigInt(first?.start ?? start), true)
    answer.setBigInt64(16, first && first.end !== Infinity ? BigInt(first.end - first.start) : 0n, true)
    answer.setInt32(24, first ? first.owner : 0, true)
    thread_of(proc).filled(28)
    return 0
  }
  if (type !== UNLOCK && !watched.has(owner)) {
    watched.add(owner)
    void leader.exited.then(() => {
      watched.delete(owner)
      waiting.delete(owner)
      drop(owner)
    })
  }
  for (;;) {
    if (type === UNLOCK || !blockers(owner, request).length) {
      place(owner, request)
      return 0
    }
    if (op === SET) throw withErrno('EAGAIN')
    if (circular(owner, request)) throw withErrno('EDEADLK')
    waiting.set(owner, request)
    try {
      await wait_event_any([changed], () => !blockers(owner, request).length, proc)
    } finally {
      waiting.delete(owner)
    }
  }
}

let installed = false
export function installRecordLocks(): void {
  if (installed) return
  installed = true
  define_syscall('lock_op', (proc: Process, op: number, key: string, type: number, start: number, end: number) => lock(proc, op, key, type, start, end))
}
