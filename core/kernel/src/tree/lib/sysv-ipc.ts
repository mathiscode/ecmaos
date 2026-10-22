/**
 * System V IPC: message queues, semaphore sets and shared memory segments, each named by a key and found by an id, for
 * every process of the system. The C library's calls reach them through the WALI host (`bin/wali-host.mjs`), which lays
 * out the C structures; what is kept here is what Linux keeps, with its limits.
 *
 * A call that waits (`msgsnd` on a full queue, `msgrcv` with nothing for it, `semop` that cannot go through yet) sleeps
 * on its object's wait queue until the object changes, and gives up with EINTR when a signal arrives first, leaving the
 * object as it was. One whose object is removed meanwhile fails with EIDRM.
 *
 * A segment is a file of its size on a file system of its own, never mounted. `shm_attach` opens it for the caller, and
 * the host maps the descriptor shared, as it maps any file (kept in step at calls, `wali-host.mjs`); the open file is
 * the attachment, so it ends where the mapping's descriptor is closed: at `shmdt`, `munmap`, exec or exit. A segment
 * removed while attached goes when its last attachment does.
 *
 * `/proc/sysvipc/msg`, `sem` and `shm` list them as Linux's do, which `ipcs` reads.
 */
import { define_syscall, thread_of, WaitQueue, wait_event_any, type Process } from '@zenfs/linux'
import { ProcDir, proc_root } from '@zenfs/linux/fs/procfs'
import { InMemory, type Credentials } from '@zenfs/core'
import { Handle, toFD } from '@zenfs/core/vfs/file'
import { cacheOf } from '@zenfs/core/vfs/vcache'
import { O_RDONLY, O_RDWR } from '@zenfs/core/constants'
import { withErrno } from 'kerium'
import { leaderOf } from './wali-threads.ts'

declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    ipc_get(kind: Kind, key: number, size: number, flags: number): number
    ipc_ctl(kind: Kind, id: number, cmd: number, arg: unknown): number
    msg_send(id: number, type: number, data: Uint8Array, flags: number): number
    msg_receive(id: number, size: number, type: number, flags: number): number
    sem_op(id: number, ops: number[], timeout: number): number
    sem_count(id: number): number
    shm_attach(id: number, flags: number): number
  }
}

export type Kind = 'msg' | 'sem' | 'shm'

const IPC_CREAT = 0o1000, IPC_EXCL = 0o2000, IPC_NOWAIT = 0o4000
const IPC_RMID = 0, IPC_SET = 1, IPC_STAT = 2, IPC_INFO = 3
const MSG_STAT = 11, MSG_INFO = 12, MSG_STAT_ANY = 13
const SEM_STAT = 18, SEM_INFO = 19, SEM_STAT_ANY = 20
const SHM_STAT = 13, SHM_INFO = 14, SHM_STAT_ANY = 15, SHM_LOCK = 11, SHM_UNLOCK = 12
const GETPID = 11, GETVAL = 12, GETALL = 13, GETNCNT = 14, GETZCNT = 15, SETVAL = 16, SETALL = 17
const MSG_NOERROR = 0o10000, MSG_EXCEPT = 0o20000
const SEM_UNDO = 0x1000
const SHM_RDONLY = 0o10000, SHM_DEST = 0o1000, SHM_LOCKED = 0o2000

/** Linux's defaults (`ipc/util.h`, `include/uapi/linux/{msg,sem,shm}.h`); a segment is held whole in memory here, so it is kept below a GiB */
const IPCMNI = 32768
export const Limits = {
  msgmax: 8192, msgmnb: 16384, msgmni: 32000,
  semmsl: 32000, semmns: 32000 * 32000, semopm: 500, semvmx: 32767, semmni: 32000, semaem: 32767,
  shmmax: 1 << 30, shmmin: 1, shmmni: 4096, shmall: (1 << 30) / 4096
}

/** `struct ipc_perm`, as `IPC_STAT` reports it */
interface Perm { key: number, uid: number, gid: number, cuid: number, cgid: number, mode: number, seq: number }

interface Base { id: number, perm: Perm, ctime: number, removed: boolean, wake: WaitQueue }

interface Queue extends Base {
  messages: Array<{ type: number, data: Uint8Array }>
  bytes: number
  qbytes: number
  stime: number, rtime: number, lspid: number, lrpid: number
}

interface SemSet extends Base {
  values: number[]
  /** The last process to change each, and how many wait for each to rise or to be zero */
  pids: number[], ncnt: number[], zcnt: number[]
  otime: number
}

interface Segment extends Base {
  size: number
  path: string
  nattch: number
  atime: number, dtime: number, cpid: number, lpid: number
}

type Entry = Queue | SemSet | Segment

/** One kind's objects: by slot (an id is its slot plus a sequence number times `IPCMNI`) and by key */
class Table<T extends Entry> {
  slots: Array<T | undefined> = []
  seqs: number[] = []
  byKey = new Map<number, T>()

  constructor(readonly max: number) {}

  add(make: (id: number, seq: number) => T, key: number): T {
    let slot = this.slots.indexOf(undefined)
    if (slot < 0) slot = this.slots.length
    if (slot >= this.max) throw withErrno('ENOSPC')
    const seq = this.seqs[slot] ?? 0
    const entry = make(seq * IPCMNI + slot, seq)
    this.slots[slot] = entry
    if (key) this.byKey.set(key, entry)
    return entry
  }

  /** @throws EINVAL for an id that is not, or is no longer, one of these */
  get(id: number): T {
    const entry = id >= 0 ? this.slots[id % IPCMNI] : undefined
    if (!entry || entry.id !== id) throw withErrno('EINVAL')
    return entry
  }

  remove(entry: T): void {
    const slot = entry.id % IPCMNI
    this.slots[slot] = undefined
    // the next object in the slot has another id, as Linux's do
    this.seqs[slot] = ((this.seqs[slot] ?? 0) + 1) % (0x7fffffff / IPCMNI | 0)
    while (this.slots.length && !this.slots[this.slots.length - 1]) this.slots.pop()
    if (this.byKey.get(entry.perm.key) === entry) this.byKey.delete(entry.perm.key)
    entry.removed = true
    entry.wake.wake_up()
  }

  /** The highest slot in use, which the `*_INFO` calls answer with */
  get highest(): number {
    return Math.max(0, this.slots.length - 1)
  }

  get live(): T[] {
    return this.slots.filter((entry): entry is T => !!entry)
  }
}

const queues = new Table<Queue>(Limits.msgmni)
const semaphores = new Table<SemSet>(Limits.semmni)
const segments = new Table<Segment>(Limits.shmmni)
const tables = { msg: queues, sem: semaphores, shm: segments } as Record<Kind, Table<Entry>>

/** Where segments' files are */
const shmfs = InMemory.create({ label: 'sysvshm' })

const seconds = () => Math.floor(Date.now() / 1000)
const credentialsOf = (proc: Process): Credentials => proc.context.credentials
/** What the program calls its process id: its leader's, for a thread */
const pidOf = (proc: Process) => leaderOf(proc).pid

const READ = 4, WRITE = 2
/** Whether the caller has `want` (READ, WRITE or both) on the object, by its mode, as Linux's `ipcperms` */
function permits(proc: Process, perm: Perm, want: number): boolean {
  const { euid, egid, groups } = credentialsOf(proc)
  if (euid === 0) return true
  const shift = euid === perm.uid || euid === perm.cuid ? 6 : egid === perm.gid || egid === perm.cgid || groups.includes(perm.gid) ? 3 : 0
  return ((perm.mode >> shift) & want) === want
}

function require(proc: Process, entry: Entry, want: number): void {
  if (!permits(proc, entry.perm, want)) throw withErrno('EACCES')
}

/** Whether the caller may change or remove the object: its owner's, its creator's, or root's */
function requireOwner(proc: Process, perm: Perm): void {
  const { euid } = credentialsOf(proc)
  if (euid !== 0 && euid !== perm.uid && euid !== perm.cuid) throw withErrno('EPERM')
}

function newPerm(proc: Process, key: number, flags: number, seq: number): Perm {
  const { euid, egid } = credentialsOf(proc)
  return { key, uid: euid, gid: egid, cuid: euid, cgid: egid, mode: flags & 0o777, seq }
}

const base = (proc: Process, id: number, key: number, flags: number, seq: number): Base =>
  ({ id, perm: newPerm(proc, key, flags, seq), ctime: seconds(), removed: false, wake: new WaitQueue() })

/** `msgget`, `semget`, `shmget` */
function get(proc: Process, kind: Kind, key: number, size: number, flags: number): number {
  const table = tables[kind]
  const existing = key ? table.byKey.get(key) : undefined
  if (existing) {
    if (flags & IPC_CREAT && flags & IPC_EXCL) throw withErrno('EEXIST')
    if (!permits(proc, existing.perm, (flags >> 6) & 7 & (READ | WRITE))) throw withErrno('EACCES')
    if (kind === 'sem' && size > (existing as SemSet).values.length) throw withErrno('EINVAL')
    if (kind === 'shm' && size > (existing as Segment).size) throw withErrno('EINVAL')
    return existing.id
  }
  if (key && !(flags & IPC_CREAT)) throw withErrno('ENOENT')
  if (kind === 'msg') {
    return queues.add((id, seq) => ({
      ...base(proc, id, key, flags, seq), messages: [], bytes: 0, qbytes: Limits.msgmnb, stime: 0, rtime: 0, lspid: 0, lrpid: 0
    }), key).id
  }
  if (kind === 'sem') {
    if (size <= 0 || size > Limits.semmsl) throw withErrno('EINVAL')
    return semaphores.add((id, seq) => ({
      ...base(proc, id, key, flags, seq), values: Array(size).fill(0), pids: Array(size).fill(0),
      ncnt: Array(size).fill(0), zcnt: Array(size).fill(0), otime: 0
    }), key).id
  }
  if (size < Limits.shmmin || size > Limits.shmmax) throw withErrno('EINVAL')
  return segments.add((id, seq) => {
    const path = `/${id}`
    shmfs.createFileSync(path, { mode: 0o600, uid: 0, gid: 0 })
    shmfs.touchSync(path, { size })
    return { ...base(proc, id, key, flags, seq), size, path, nattch: 0, atime: 0, dtime: 0, cpid: pidOf(proc), lpid: 0 }
  }, key).id
}

/** A segment goes once it is removed and no longer attached */
function destroySegment(segment: Segment): void {
  if (!(segment.perm.mode & SHM_DEST) || segment.nattch) return
  segments.remove(segment)
  shmfs.unlinkSync(segment.path)
}

/** `IPC_RMID`: a segment still attached is only marked, and its key let go, so a get makes a new one */
function remove(kind: Kind, entry: Entry): void {
  if (kind !== 'shm') {
    tables[kind].remove(entry)
    if (kind === 'sem') dropUndo(entry.id)
    return
  }
  const segment = entry as Segment
  if (segments.byKey.get(segment.perm.key) === segment) segments.byKey.delete(segment.perm.key)
  segment.perm.key = 0
  segment.perm.mode |= SHM_DEST
  destroySegment(segment)
}

/** What a `*_STAT` call reports, for the host to lay out as the C structure */
function describe(kind: Kind, entry: Entry): Record<string, unknown> {
  const common = { perm: entry.perm, ctime: entry.ctime }
  if (kind === 'msg') {
    const q = entry as Queue
    return { ...common, stime: q.stime, rtime: q.rtime, cbytes: q.bytes, qnum: q.messages.length, qbytes: q.qbytes, lspid: q.lspid, lrpid: q.lrpid }
  }
  if (kind === 'sem') {
    const s = entry as SemSet
    return { ...common, otime: s.otime, nsems: s.values.length }
  }
  const m = entry as Segment
  return { ...common, segsz: m.size, atime: m.atime, dtime: m.dtime, cpid: m.cpid, lpid: m.lpid, nattch: m.nattch }
}

/** What `IPC_INFO` and the kind's own `*_INFO` report: the limits, or for the latter what is in use */
function info(kind: Kind, usage: boolean): Record<string, number> {
  if (kind === 'msg') {
    const live = queues.live
    return {
      msgpool: usage ? live.length : Math.floor(Limits.msgmni * Limits.msgmnb / 1024), msgmap: usage ? live.reduce((n, q) => n + q.messages.length, 0) : Limits.msgmnb,
      msgmax: Limits.msgmax, msgmnb: Limits.msgmnb, msgmni: Limits.msgmni, msgssz: 16,
      msgtql: usage ? live.reduce((n, q) => n + q.bytes, 0) : Limits.msgmnb, msgseg: 0xffff
    }
  }
  if (kind === 'sem') {
    const live = semaphores.live
    return {
      semmap: Limits.semmns, semmni: Limits.semmni, semmns: Limits.semmns, semmnu: Limits.semmns, semmsl: Limits.semmsl,
      semopm: Limits.semopm, semume: Limits.semopm, semusz: usage ? live.length : 20, semvmx: Limits.semvmx,
      semaem: usage ? live.reduce((n, s) => n + s.values.length, 0) : Limits.semaem
    }
  }
  if (!usage) return { shmmax: Limits.shmmax, shmmin: Limits.shmmin, shmmni: Limits.shmmni, shmseg: Limits.shmmni, shmall: Limits.shmall }
  const live = segments.live
  const pages = live.reduce((n, m) => n + Math.ceil(m.size / 4096), 0)
  return { used_ids: live.length, shm_tot: pages, shm_rss: pages, shm_swp: 0, swap_attempts: 0, swap_successes: 0 }
}

const answer = (proc: Process, value: unknown) => thread_of(proc).put(new TextEncoder().encode(JSON.stringify(value)))

/** The `*ctl` calls. A call that answers with a structure leaves it in the region as JSON; `cmd` is without `IPC_64` */
function control(proc: Process, kind: Kind, id: number, cmd: number, arg: unknown): number {
  const table = tables[kind]
  const statByIndex = { msg: [MSG_STAT, MSG_STAT_ANY], sem: [SEM_STAT, SEM_STAT_ANY], shm: [SHM_STAT, SHM_STAT_ANY] }[kind]
  const usage = { msg: MSG_INFO, sem: SEM_INFO, shm: SHM_INFO }[kind]
  if (cmd === IPC_INFO || cmd === usage) {
    answer(proc, info(kind, cmd === usage))
    return table.highest
  }
  // by slot rather than id, as `ipcs` lists them; the answer is the id
  if (statByIndex.includes(cmd)) {
    const entry = table.slots[id]
    if (!entry) throw withErrno('EINVAL')
    if (cmd === statByIndex[0]) require(proc, entry, READ)
    answer(proc, describe(kind, entry))
    return entry.id
  }
  const entry = table.get(id)
  switch (cmd) {
    case IPC_STAT:
      require(proc, entry, READ)
      answer(proc, describe(kind, entry))
      return 0
    case IPC_SET: {
      requireOwner(proc, entry.perm)
      const set = arg as { uid: number, gid: number, mode: number, qbytes?: number }
      if (kind === 'msg' && set.qbytes !== undefined) {
        const queue = entry as Queue
        if (set.qbytes > Limits.msgmnb && credentialsOf(proc).euid !== 0) throw withErrno('EPERM')
        queue.qbytes = set.qbytes
        queue.wake.wake_up()
      }
      Object.assign(entry.perm, { uid: set.uid, gid: set.gid, mode: (entry.perm.mode & ~0o777) | (set.mode & 0o777) })
      entry.ctime = seconds()
      return 0
    }
    case IPC_RMID:
      requireOwner(proc, entry.perm)
      remove(kind, entry)
      return 0
  }
  if (kind === 'shm' && (cmd === SHM_LOCK || cmd === SHM_UNLOCK)) {
    requireOwner(proc, entry.perm)
    entry.perm.mode = cmd === SHM_LOCK ? entry.perm.mode | SHM_LOCKED : entry.perm.mode & ~SHM_LOCKED
    return 0
  }
  if (kind !== 'sem') throw withErrno('EINVAL')
  return semControl(proc, entry as SemSet, cmd, arg)
}

function semControl(proc: Process, set: SemSet, cmd: number, arg: unknown): number {
  const at = (num: number) => {
    if (num < 0 || num >= set.values.length) throw withErrno('EINVAL')
    return num
  }
  const [num = 0, value = 0] = Array.isArray(arg) && cmd !== SETALL ? arg as number[] : []
  switch (cmd) {
    case GETVAL: require(proc, set, READ); return set.values[at(num)]!
    case GETPID: require(proc, set, READ); return set.pids[at(num)]!
    case GETNCNT: require(proc, set, READ); return set.ncnt[at(num)]!
    case GETZCNT: require(proc, set, READ); return set.zcnt[at(num)]!
    case GETALL:
      require(proc, set, READ)
      answer(proc, set.values)
      return 0
    case SETVAL:
    case SETALL: {
      require(proc, set, WRITE)
      const values = cmd === SETALL ? arg as number[] : [value]
      if (values.some(v => v < 0 || v > Limits.semvmx)) throw withErrno('ERANGE')
      const pid = pidOf(proc)
      if (cmd === SETALL) {
        set.values = [...values]
        set.pids.fill(pid)
      } else {
        set.values[at(num)] = value
        set.pids[num] = pid
      }
      clearUndo(set.id, cmd === SETALL ? undefined : num)
      set.ctime = seconds()
      set.wake.wake_up()
      return 0
    }
  }
  throw withErrno('EINVAL')
}

// --- messages ---

function matches(type: number, wanted: number, flags: number): boolean {
  if (!wanted) return true
  if (wanted < 0) return type <= -wanted
  return flags & MSG_EXCEPT ? type !== wanted : type === wanted
}

/** The message `msgrcv` takes: the first that matches, or for a negative type the lowest type at most its size */
function pick(queue: Queue, wanted: number, flags: number): number {
  if (wanted >= 0) return queue.messages.findIndex(message => matches(message.type, wanted, flags))
  let best = -1
  queue.messages.forEach((message, i) => {
    if (message.type <= -wanted && (best < 0 || message.type < queue.messages[best]!.type)) best = i
  })
  return best
}

async function send(proc: Process, id: number, type: number, data: Uint8Array, flags: number): Promise<number> {
  const queue = queues.get(id)
  require(proc, queue, WRITE)
  if (type < 1 || data.byteLength > Limits.msgmax) throw withErrno('EINVAL')
  const fits = () => queue.removed || (queue.bytes + data.byteLength <= queue.qbytes && queue.messages.length < queue.qbytes)
  while (!fits()) {
    if (flags & IPC_NOWAIT) throw withErrno('EAGAIN')
    await wait_event_any([queue.wake], fits, proc)
  }
  if (queue.removed) throw withErrno('EIDRM')
  queue.messages.push({ type, data: data.slice() })
  queue.bytes += data.byteLength
  Object.assign(queue, { stime: seconds(), lspid: pidOf(proc) })
  queue.wake.wake_up()
  return 0
}

/** `msgrcv`: the message's type (8 bytes) and then its text go in the region. @returns the text's length */
async function receive(proc: Process, id: number, size: number, type: number, flags: number): Promise<number> {
  const queue = queues.get(id)
  require(proc, queue, READ)
  if (size < 0) throw withErrno('EINVAL')
  const found = () => queue.removed || pick(queue, type, flags) >= 0
  while (!found()) {
    if (flags & IPC_NOWAIT) throw withErrno('ENOMSG')
    await wait_event_any([queue.wake], found, proc)
  }
  if (queue.removed) throw withErrno('EIDRM')
  const index = pick(queue, type, flags)
  const message = queue.messages[index]!
  if (message.data.byteLength > size && !(flags & MSG_NOERROR)) throw withErrno('E2BIG')
  queue.messages.splice(index, 1)
  queue.bytes -= message.data.byteLength
  Object.assign(queue, { rtime: seconds(), lrpid: pidOf(proc) })
  queue.wake.wake_up()
  const { region } = thread_of(proc)
  const length = Math.min(size, message.data.byteLength, region.byteLength - 8)
  new DataView(region.buffer, region.byteOffset).setBigInt64(0, BigInt(message.type), true)
  region.set(message.data.subarray(0, length), 8)
  thread_of(proc).filled(8 + length)
  return length
}

// --- semaphores ---

/** `SEM_UNDO`: what each process's operations are to be undone by when it ends, per set and semaphore */
const undo = new Map<Process, Map<number, Map<number, number>>>()

function recordUndo(proc: Process, id: number, num: number, change: number): void {
  const leader = leaderOf(proc)
  let sets = undo.get(leader)
  if (!sets) {
    undo.set(leader, (sets = new Map()))
    void leader.exited.then(() => applyUndo(leader))
  }
  let adjust = sets.get(id)
  if (!adjust) sets.set(id, (adjust = new Map()))
  adjust.set(num, (adjust.get(num) ?? 0) - change)
}

/** A process's end: its adjustments are made, each kept within what a semaphore may hold, as Linux does */
function applyUndo(leader: Process): void {
  const sets = undo.get(leader)
  undo.delete(leader)
  for (const [id, adjust] of sets ?? []) {
    let set: SemSet
    try { set = semaphores.get(id) } catch { continue }
    for (const [num, change] of adjust) {
      if (num >= set.values.length) continue
      set.values[num] = Math.max(0, Math.min(Limits.semvmx, set.values[num]! + change))
      set.pids[num] = leader.pid
    }
    set.wake.wake_up()
  }
}

/** `SETVAL` and `SETALL` clear every process's adjustments for what they set */
function clearUndo(id: number, num?: number): void {
  for (const sets of undo.values()) {
    if (num === undefined) sets.delete(id)
    else sets.get(id)?.delete(num)
  }
}

function dropUndo(id: number): void {
  for (const sets of undo.values()) sets.delete(id)
}

/**
 * `semop` and `semtimedop`: `ops` is each operation's semaphore, change and flags in turn. They are made together or not
 * at all; until they can be, the caller waits (counted in the semaphore's GETNCNT or GETZCNT) unless the one that cannot
 * go through has `IPC_NOWAIT`. @param timeout how long to wait in ms, or a negative number for as long as it takes
 */
async function semop(proc: Process, id: number, ops: number[], timeout: number): Promise<number> {
  const count = ops.length / 3
  if (count < 1) throw withErrno('EINVAL')
  if (count > Limits.semopm) throw withErrno('E2BIG')
  const set = semaphores.get(id)
  const alters = ops.some((value, i) => i % 3 === 1 && value !== 0)
  require(proc, set, alters ? WRITE : READ)
  for (let i = 0; i < ops.length; i += 3) if (ops[i]! >= set.values.length) throw withErrno('EFBIG')
  const deadline = timeout < 0 ? Infinity : Date.now() + timeout

  /** The operations made on a copy: the new values, or the operation that would have to wait */
  const attempt = (): { values: number[] } | { blocked: number } => {
    const values = [...set.values]
    for (let i = 0; i < ops.length; i += 3) {
      const num = ops[i]!, change = ops[i + 1]!, value = values[num]!
      if (change > 0 && value + change > Limits.semvmx) throw withErrno('ERANGE')
      if ((change < 0 && value + change < 0) || (change === 0 && value !== 0)) return { blocked: i }
      values[num] = value + change
    }
    return { values }
  }

  /** Whether there is anything to look again for: the set gone, or the operations able to go through (or to fail) */
  const ready = () => {
    if (set.removed) return true
    try { return 'values' in attempt() } catch { return true }
  }

  for (;;) {
    if (set.removed) throw withErrno('EIDRM')
    const result = attempt()
    if ('values' in result) {
      const pid = pidOf(proc)
      set.values = result.values
      for (let i = 0; i < ops.length; i += 3) {
        set.pids[ops[i]!] = pid
        if (ops[i + 2]! & SEM_UNDO && ops[i + 1]) recordUndo(proc, id, ops[i]!, ops[i + 1]!)
      }
      set.otime = seconds()
      if (alters) set.wake.wake_up()
      return 0
    }
    const { blocked } = result
    if (ops[blocked + 2]! & IPC_NOWAIT) throw withErrno('EAGAIN')
    const left = deadline - Date.now()
    if (left <= 0) throw withErrno('EAGAIN')
    const num = ops[blocked]!, counter = ops[blocked + 1] ? set.ncnt : set.zcnt
    counter[num]!++
    try {
      await wait_event_any([set.wake], ready, proc, left === Infinity ? -1 : left)
    } finally {
      counter[num]!--
    }
  }
}

// --- shared memory ---

/** An attachment: the segment's file open for a process, which detaches it when the last descriptor for it closes */
class Attachment extends Handle {
  constructor(proc: Process, readonly segment: Segment, flag: number) {
    const inode = shmfs.statSync(segment.path)
    super(proc.context, `/SYSV${(segment.perm.key >>> 0).toString(16).padStart(8, '0')} (deleted)`, segment.path, flag, cacheOf(shmfs).ref(segment.path, inode))
    this.pid = pidOf(proc)
    segment.nattch++
    Object.assign(segment, { atime: seconds(), lpid: this.pid })
  }

  readonly pid: number
  #detached = false

  #detach(): void {
    if (this.#detached) return
    this.#detached = true
    this.segment.nattch--
    Object.assign(this.segment, { dtime: seconds(), lpid: this.pid })
    destroySegment(this.segment)
  }

  override disposeSync(force?: boolean): void {
    super.disposeSync(force)
    this.#detach()
  }

  override dispose(force?: boolean): void {
    super.dispose(force)
    this.#detach()
  }
}

/** `shmat`'s half here: a descriptor for the segment, which the host maps shared. @returns the descriptor */
function attach(proc: Process, id: number, flags: number): number {
  const segment = segments.get(id)
  const readOnly = !!(flags & SHM_RDONLY)
  require(proc, segment, readOnly ? READ : READ | WRITE)
  if (segment.perm.mode & SHM_DEST) throw withErrno('EIDRM')
  return toFD(new Attachment(proc, segment, readOnly ? O_RDONLY : O_RDWR), proc.context)
}

/** printf's `%<width>d` and `%-<width>d` for the procfs lines */
const right = (value: number | string, width: number) => String(value).padStart(width)
const octal = (mode: number) => right((mode & 0o7777).toString(8), 4)

/** The lines of `/proc/sysvipc/<kind>`: Linux's headings and columns (ipc/msg.c, sem.c and shm.c, 64-bit) */
function procLines(kind: Kind): string {
  const owner = (entry: Entry) => [entry.perm.uid, entry.perm.gid, entry.perm.cuid, entry.perm.cgid].map(n => right(n, 5)).join(' ')
  const head = (entry: Entry) => `${right(entry.perm.key | 0, 10)} ${right(entry.id, 10)}  ${octal(entry.perm.mode)}`
  if (kind === 'msg') {
    return '       key      msqid perms      cbytes       qnum lspid lrpid   uid   gid  cuid  cgid      stime      rtime      ctime\n' +
      queues.live.map(q => `${head(q)}  ${right(q.bytes, 10)} ${right(q.messages.length, 10)} ${right(q.lspid, 5)} ${right(q.lrpid, 5)} ${owner(q)} ${right(q.stime, 10)} ${right(q.rtime, 10)} ${right(q.ctime, 10)}\n`).join('')
  }
  if (kind === 'sem') {
    return '       key      semid perms      nsems   uid   gid  cuid  cgid      otime      ctime\n' +
      semaphores.live.map(set => `${head(set)} ${right(set.values.length, 10)} ${owner(set)} ${right(set.otime, 10)} ${right(set.ctime, 10)}\n`).join('')
  }
  return '       key      shmid perms                  size  cpid  lpid nattch   uid   gid  cuid  cgid      atime      dtime      ctime                   rss                  swap\n' +
    segments.live.map(m => {
      const rss = Math.ceil(m.size / 4096) * 4096
      return `${head(m)} ${right(m.size, 21)} ${right(m.cpid, 5)} ${right(m.lpid, 5)}  ${right(m.nattch, 5)} ${owner(m)} ${right(m.atime, 10)} ${right(m.dtime, 10)} ${right(m.ctime, 10)} ${right(rss, 21)} ${right(0, 21)}\n`
    }).join('')
}

let installed = false
export function installSysvIpc(): void {
  if (installed) return
  installed = true
  proc_root.children.set('sysvipc', new ProcDir(Object.fromEntries((['msg', 'sem', 'shm'] as Kind[]).map(kind => [kind, { mode: 0o444, show: () => procLines(kind) }]))))
  define_syscall('ipc_get', (proc: Process, kind: Kind, key: number, size: number, flags: number) => get(proc, kind, key, size, flags))
  define_syscall('ipc_ctl', (proc: Process, kind: Kind, id: number, cmd: number, arg: unknown) => control(proc, kind, id, cmd, arg))
  define_syscall('msg_send', (proc: Process, id: number, type: number, data: Uint8Array, flags: number) => send(proc, id, type, data, flags))
  define_syscall('msg_receive', (proc: Process, id: number, size: number, type: number, flags: number) => receive(proc, id, size, type, flags))
  /** How many semaphores a set has, which `SETALL`'s array is as long as */
  define_syscall('sem_count', (_proc: Process, id: number) => semaphores.get(id).values.length)
  define_syscall('sem_op', (proc: Process, id: number, ops: number[], timeout: number) => semop(proc, id, ops, timeout))
  define_syscall('shm_attach', (proc: Process, id: number, flags: number) => attach(proc, id, flags))
}
