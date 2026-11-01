/**
 * `eventfd(2)` and `timerfd_create(2)`: a descriptor that is a 64-bit counter. Reading takes the count (an event counter
 * in semaphore mode takes one) and waits while it is zero; writing adds to it. A timer adds one to its counter at each
 * expiration, so a read says how many there have been. Both are a descriptor of the kind the named pipes use for read-write
 * (`makeSpecialFd`), so `poll` and `epoll` see them like any other, and the timer runs here, on the main thread, which
 * keeps running while the program that set it sleeps in `poll`.
 */

import { define_syscall, type Process, type WaitQueue } from '@zenfs/linux'
import { EPOLLIN, EPOLLOUT } from '@zenfs/linux/fs/devtmpfs'
import { withErrno } from 'kerium'
import { makeSpecialFd, specialIdOf } from './fifo.ts'

declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    counter_create(kind: number, initial: number, flags: number): number
    timerfd_settime(fd: number, delayMicros: number, intervalMicros: number): number
    timerfd_gettime(fd: number, which: number): number
  }
}

const LIMIT = 0xffffffffffffffffn - 1n
const EFD_SEMAPHORE = 1
const O_NONBLOCK = 0o4000

interface Timer { handle?: ReturnType<typeof setTimeout>, deadline: number, interval: number }
interface Counter { value: bigint, semaphore: boolean, isTimer: boolean, timer?: Timer, queue: WaitQueue }

const counters = new Map<number, Counter>()

const ops = (id: number) => {
  const counter = () => counters.get(id)!
  return {
    read(_file: unknown, buffer: Uint8Array, start: number, end: number) {
      const c = counter()
      if (end - start < 8) throw withErrno('EINVAL')
      if (c.value === 0n) throw withErrno('EAGAIN')
      const taken = c.semaphore ? 1n : c.value
      c.value -= taken
      new DataView(buffer.buffer, buffer.byteOffset + start, 8).setBigUint64(0, taken, true)
      c.queue.wake_up()
      return 8
    },
    write(_file: unknown, buffer: Uint8Array) {
      const c = counter()
      if (buffer.byteLength < 8) throw withErrno('EINVAL')
      const added = new DataView(buffer.buffer, buffer.byteOffset, 8).getBigUint64(0, true)
      if (added === 0xffffffffffffffffn) throw withErrno('EINVAL')
      if (c.value + added > LIMIT) throw withErrno('EAGAIN')
      c.value += added
      c.queue.wake_up()
      return 8
    },
    poll(_file: unknown) {
      const c = counter()
      return (c.value > 0n ? EPOLLIN : 0) | (c.value < LIMIT ? EPOLLOUT : 0)
    },
    poll_wait: (_file: unknown) => counter().queue
  }
}

function disarm(counter: Counter): void {
  if (counter.timer?.handle !== undefined) clearTimeout(counter.timer.handle)
  counter.timer = undefined
}

/** Schedules the timer's next expiration; each one adds the expirations that have passed (a slow main thread can miss some) */
function schedule(counter: Counter): void {
  const timer = counter.timer
  if (!timer) return
  timer.handle = setTimeout(() => {
    timer.handle = undefined
    if (counter.timer !== timer) return
    const now = performance.now()
    let expirations = 1
    if (timer.interval > 0) {
      expirations += Math.max(0, Math.floor((now - timer.deadline) / timer.interval))
      timer.deadline += expirations * timer.interval
    }
    counter.value = counter.value + BigInt(expirations) > LIMIT ? LIMIT : counter.value + BigInt(expirations)
    counter.queue.wake_up()
    if (timer.interval > 0) schedule(counter)
    else counter.timer = undefined
  }, Math.max(0, timer.deadline - performance.now()))
}

/** The timer behind `fd`; an event counter, or a descriptor of any other kind, is not one */
function counterOf(proc: Process, fd: number): Counter {
  const id = specialIdOf(proc, fd)
  const counter = id === undefined ? undefined : counters.get(id)
  if (!counter?.isTimer) throw withErrno('EINVAL')
  return counter
}

export function installCounterFds(): void {
  /** `eventfd2(2)` (kind 0, with its initial count) and `timerfd_create(2)` (kind 1); the descriptor is the answer */
  define_syscall('counter_create', (proc: Process, kind: number, initial: number, flags: number) => {
    if (kind !== 0 && kind !== 1) throw withErrno('EINVAL')
    return makeSpecialFd(proc, flags & O_NONBLOCK, (id, queue) => {
      counters.set(id, { value: kind === 0 ? BigInt(initial) : 0n, semaphore: kind === 0 && (flags & EFD_SEMAPHORE) !== 0, isTimer: kind === 1, queue })
      return ops(id)
    }, id => {
      const counter = counters.get(id)
      if (counter) disarm(counter)
      counters.delete(id)
    })
  })

  /** `timerfd_settime(2)`: first expiration after `delayMicros` (0 stops the timer), then every `intervalMicros` (0 for once) */
  define_syscall('timerfd_settime', (proc: Process, fd: number, delayMicros: number, intervalMicros: number) => {
    const counter = counterOf(proc, fd)
    disarm(counter)
    counter.value = 0n
    if (delayMicros > 0) {
      counter.timer = { deadline: performance.now() + delayMicros / 1000, interval: intervalMicros / 1000 }
      schedule(counter)
    }
    return 0
  })

  /** `timerfd_gettime(2)`: `which` 0 is the time left to the next expiration, in microseconds, and 1 the interval */
  define_syscall('timerfd_gettime', (proc: Process, fd: number, which: number) => {
    const timer = counterOf(proc, fd).timer
    if (!timer) return 0
    return Math.round(which === 0 ? Math.max(0, timer.deadline - performance.now()) * 1000 : timer.interval * 1000)
  })
}
