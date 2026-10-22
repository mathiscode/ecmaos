/**
 * Signals to WALI programs that the dependency's kernel does not carry itself:
 *
 * - to a program that is computing, making no syscalls. The kernel raises a signal on a thread's page, which the thread
 *   reads only as a syscall returns; a WALI program's loops read a word of its memory instead
 *   (`utils/wali/signal-checks.mjs`), and while it is set call into the host (`bin/wali-host.mjs` `__ecmaos_poll`),
 *   which delivers what is pending. The word is the process's, one for all its threads: the kernel sets it as it
 *   raises a signal on any of them, or stops the process, and clears it once no thread has signals waiting and none
 *   stopped is still computing. The host clears a page as it takes the signals off it, by `proc_signal_poll`, as does
 *   each loop's call, so the kernel looks again then.
 * - the real-time signals, 32 to 64 (the kernel's are the standard 31, which a page holds in a 32-bit word). They are
 *   queued here per thread, every one sent delivered (a standard one sent while it is pending merges with it), and
 *   raising one marks the page with bit 0, which wakes a thread blocked in a syscall with EINTR as any signal does; the
 *   host takes them off the queue with `proc_signal_poll`. A process takes the ones its program handles, ignores or
 *   blocks (`proc_rt_sigstate`); any other ends it, with its threads, their default action.
 */
import { define_syscall, Process, Thread, thread_of, type Signal } from '@zenfs/linux'
import { withErrno } from 'kerium'
import { leaderOf, threadsOf } from './wali-threads.ts'

declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    proc_signal_word(memory: SharedArrayBuffer, address: number): number
    proc_signal_poll(): number
    proc_rt_sigstate(low: number, high: number): number
  }
}

const SIGRTMIN = 32, SIGRTMAX = 64
/** How many real-time signals may wait for a thread: more are dropped, as Linux drops past `RLIMIT_SIGPENDING` */
const QUEUE_LIMIT = 4096

/** Each WALI process's word, in its memory, by its leader */
const words = new WeakMap<Process, Int32Array>()
/** The real-time signals each thread takes, as bits from SIGRTMIN up, and those waiting for it, in the order sent */
const taken = new WeakMap<Process, bigint>()
const queues = new WeakMap<Process, number[]>()

type Page = { signals: number, status: Int32Array }
const pageOf = (proc: Process) => (proc.thread as unknown as { control?: Page } | undefined)?.control
/** The page's status while its thread waits on a syscall (upstream's `SyscallStatus.Pending`) */
const PENDING = 0

/** Makes the process's loops call in */
function wake(proc: Process): void {
  const word = words.get(leaderOf(proc))
  if (word) Atomics.store(word, 0, 1)
}

/**
 * Whether a thread still has to call in: signals on its page or on its queue, or stopped while it computes (not waiting
 * on a syscall)
 */
function waiting(proc: Process): boolean {
  const page = pageOf(proc)
  if (proc.code !== undefined || !page) return false
  return page.signals !== 0 || !!queues.get(proc)?.length || (proc.stopped && Atomics.load(page.status, 0) !== PENDING)
}

/** Tells a process that is stopped, but may be computing, to call in: the call is held until it is continued */
export function noticeStop(proc: Process): void {
  wake(proc)
}

/**
 * A real-time signal to a process or one of its threads: queued, if its program takes it, or the end of the process.
 * A thread that has not said which it takes yet has the process's, its handlers being the process's
 */
function sendRealTime(proc: Process, signal: number): boolean {
  if (proc.code !== undefined) return false
  const set = taken.get(proc) ?? taken.get(leaderOf(proc)) ?? 0n
  if (((set >> BigInt(signal - SIGRTMIN)) & 1n) && proc.thread) {
    let queue = queues.get(proc)
    if (!queue) queues.set(proc, (queue = []))
    if (queue.length >= QUEUE_LIMIT) return false
    queue.push(signal)
    proc.thread.raise(0 as Signal)
    return true
  }
  const leader = leaderOf(proc)
  if (leader.pid === 1) return false
  leader.killed_by = signal as Signal
  leader.exit(128 + signal)
  return true
}

let installed = false
export function installWaliSignals(): void {
  if (installed) return
  installed = true

  define_syscall('proc_signal_word', (proc: Process, memory: SharedArrayBuffer, address: number) => {
    if (!(memory instanceof SharedArrayBuffer) || address % 4 || address + 4 > memory.byteLength) throw withErrno('EINVAL')
    words.set(leaderOf(proc), new Int32Array(memory, address, 1))
    return 0
  })

  // the caller's real-time signals, one a byte; its page was cleared as it made the call, so it is only the others
  // that can keep the word set
  define_syscall('proc_signal_poll', (proc: Process) => {
    const queue = queues.get(proc) ?? []
    const thread = thread_of(proc)
    const count = Math.min(queue.length, thread.region.length)
    thread.region.set(queue.splice(0, count))
    thread.filled(count)
    const leader = leaderOf(proc)
    const word = words.get(leader)
    if (word) Atomics.store(word, 0, [leader, ...threadsOf(leader)].some(waiting) ? 1 : 0)
    return count
  })

  define_syscall('proc_rt_sigstate', (proc: Process, low: number, high: number) => {
    taken.set(proc, BigInt(low >>> 0) | (BigInt(high >>> 0) << 32n))
    return 0
  })

  const raise = Thread.prototype.raise
  Thread.prototype.raise = function (this: Thread, signal: Signal) {
    raise.call(this, signal)
    wake(this.proc)
  }

  const kill = Process.prototype.kill
  Process.prototype.kill = function (this: Process, signal: Parameters<typeof kill>[0]) {
    if (typeof signal === 'number' && signal >= SIGRTMIN && signal <= SIGRTMAX) return sendRealTime(this, signal)
    return kill.call(this, signal)
  }
}
