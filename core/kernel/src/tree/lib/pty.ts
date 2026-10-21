/**
 * Pseudo-terminals: `/dev/ptmx` and `/dev/pts/<n>`. The slave is a `@zenfs/linux` tty whose "hardware" is the master:
 * what the slave writes the master reads, and what is written to the master arrives as typed.
 * Opening `/dev/ptmx` allocates a pair by wrapping the `open` syscall (as `fd-links.ts` does for `/dev/fd`); a pair
 * is freed when the last descriptor on its master closes. The master answers `TIOCGPTN` and `TIOCSPTLCK`.
 * `/dev/tty` resolves to the caller's controlling terminal.
 */

import { CharDevice, Class, Device, Process, Signal, TTYDriver, WaitQueue, processes, syscalls, tty_class } from '@zenfs/linux'
import type { DeviceFile, TTY } from '@zenfs/linux'
import { EPOLLIN, EPOLLOUT } from '@zenfs/linux'

/** Linux's `ptmx` (`5:2`), the legacy BSD master major (`128`) and the unix98 slave major (`136`). */
const PTMX = { major: 5, minor: 2 }
const MASTER_MAJOR = 128
const SLAVE_MAJOR = 136
const LINES = 256

export const TIOCGPTN = 0x80045430
export const TIOCSPTLCK = 0x40045431
const TIOCGWINSZ = 0x5413
const TIOCSWINSZ = 0x5414
const TCGETS = 0x5401
const TCSETS = 0x5402

interface Pair {
  index: number
  slave: TTY
  /** What the slave wrote and the master has not read yet */
  output: Uint8Array[]
  wait: WaitQueue
  masterPath: string
  masterDevice: Device
  /** Set once the master descriptor exists, so a pair still being opened is not swept up */
  opened: boolean
  locked: boolean
  /** Kernel code holds the master (`createPty`) instead of a descriptor, so the sweep leaves the pair alone */
  held: boolean
  /** Where the slave's output goes when the kernel holds the master */
  listeners: Set<(data: Uint8Array) => void>
}

const pairs = new Map<number, Pair>()

const pts = new TTYDriver({
  name: 'pts',
  major: SLAVE_MAJOR,
  lines: LINES,
  type: 'pty',
  subtype: 'slave',
  ops: {
    write(tty, data) {
      const pair = pairs.get(tty.index)
      if (!pair) return
      if (pair.held) { for (const listener of pair.listeners) listener(data.slice()); return }
      pair.output.push(data.slice())
      pair.wait.wake_up()
    },
  },
})

const masters = new CharDevice({
  read(file, buffer, start, end) {
    const pair = pairs.get(file.devt.minor)
    if (!pair) return 0
    let count = 0
    while (pair.output.length && start + count < end) {
      const chunk = pair.output[0] as Uint8Array
      const take = Math.min(chunk.length, end - start - count)
      buffer.set(chunk.subarray(0, take), start + count)
      count += take
      if (take === chunk.length) pair.output.shift()
      else pair.output[0] = chunk.subarray(take)
    }
    return count
  },
  write(file, buffer) {
    const pair = pairs.get(file.devt.minor)
    if (!pair) return 0
    pair.slave.receive(buffer.slice())
    return buffer.length
  },
  poll: file => {
    const pair = pairs.get(file.devt.minor)
    return (pair?.output.length ? EPOLLIN : 0) | EPOLLOUT
  },
  poll_wait: file => pairs.get(file.devt.minor)?.wait,
  ioctl: {
    [TIOCGPTN]: (_$, file: DeviceFile) => file.devt.minor,
    [TIOCSPTLCK]: (_$, file: DeviceFile, lock: number) => { const pair = pairs.get(file.devt.minor); if (pair) pair.locked = !!lock },
    [TIOCGWINSZ]: (_$, file: DeviceFile) => pairs.get(file.devt.minor)?.slave.winsize,
    [TIOCSWINSZ]: (_$, file: DeviceFile, size: { rows: number, cols: number }) => {
      const pair = pairs.get(file.devt.minor)
      if (!pair) return
      pair.slave.winsize = size
      pair.slave.signal(Signal.WINCH)
    },
    [TCGETS]: (_$, file: DeviceFile) => pairs.get(file.devt.minor)?.slave.termios,
    [TCSETS]: (_$, file: DeviceFile, termios: object) => { pairs.get(file.devt.minor)?.slave.set_termios(termios) },
  },
})

const master_class = new Class('ptm')
let ptmx: Device | undefined
let installed = false

/** The lowest free line, or throws `ENOSPC`. */
function allocate(): Pair {
  let index = 0
  while (pairs.has(index)) index++
  if (index >= LINES) throw Object.assign(new Error('No free pseudo-terminals'), { errno: 28 })

  const slave = pts.line(index)
  slave.register(`pts/${index}`)
  slave.open()
  const masterDevice = new Device({ name: `pts/.ptm${index}`, class: master_class, dev_t: { major: MASTER_MAJOR, minor: index } })
  masterDevice.register()
  const pair: Pair = { index, slave, output: [], wait: new WaitQueue(), masterPath: `/pts/.ptm${index}`, masterDevice, opened: false, locked: true, held: false, listeners: new Set() }
  pairs.set(index, pair)
  return pair
}

function release(pair: Pair): void {
  pairs.delete(pair.index)
  // The slave's users see a hangup, as on Linux when the master goes away.
  try { pair.slave.signal(Signal.HUP) } catch { /* nothing in front of it */ }
  try { pair.slave.close() } catch { /* already closed */ }
  pair.slave.unregister()
  pts.ttys.delete(pair.index)
  pair.masterDevice.unregister()
  pair.wait.wake_up()
}

/** How many descriptors, in any process, are open on a pair's master. */
function masterRefs(pair: Pair): number {
  let count = 0
  for (const proc of processes.values()) {
    for (const handle of proc.context.descriptors.values()) {
      const path = (handle as unknown as { internalPath?: string, path?: string }).internalPath ?? (handle as unknown as { path?: string }).path
      if (path === pair.masterPath) count++
    }
  }
  return count
}

/** The `/dev/pts/<n>` number of a slave tty, or `undefined` when it is not a pty's */
export function ptyIndexOf(tty: TTY | null | undefined): number | undefined {
  if (!tty) return undefined
  for (const pair of pairs.values()) if (pair.slave === tty) return pair.index
}

/** The device path of a terminal: `/dev/pts/<index>` for a pty's slave, `/dev/<name>` for the others */
export function ttyPathOf(tty: TTY): string {
  const index = ptyIndexOf(tty)
  return index === undefined ? `/dev/${tty.name}` : `/dev/pts/${index}`
}

/** The slave tty of `/dev/pts/<index>`, or `undefined` when there is none */
export function ptySlaveOf(index: number): TTY | undefined {
  return pairs.get(index)?.slave
}

/** Frees every pair whose master has no descriptor left. */
export function sweepPtys(): void {
  for (const pair of [...pairs.values()]) {
    if (pair.opened && !pair.held && masterRefs(pair) === 0) release(pair)
  }
}

/** A pty whose master the kernel itself holds, for a terminal emulator running on the main thread */
export interface KernelPty {
  index: number
  /** The slave's device path, `/dev/pts/<index>` */
  path: string
  /** The slave tty (the controlling terminal for what runs on it) */
  slave: TTY
  /** Types into the terminal, as bytes written to the master */
  write(data: string | Uint8Array): void
  /** Receives what the slave writes; returns an unsubscribe */
  onData(listener: (data: Uint8Array) => void): () => void
  /** Sets the window size and raises SIGWINCH for the foreground process */
  resize(cols: number, rows: number): void
  /** Releases the master: the slave's users see a hangup */
  close(): void
}

/** Allocates a pair and returns the master side as an object, with no descriptor involved. Throws `ENOSPC` when none is free. */
export function createPty(size: { cols: number, rows: number } = { cols: 80, rows: 24 }): KernelPty {
  installPtys()
  const pair = allocate()
  pair.opened = true
  pair.held = true
  pair.locked = false
  pair.slave.winsize = { rows: size.rows, cols: size.cols }
  const encoder = new TextEncoder()
  let closed = false
  return {
    index: pair.index,
    path: `/dev/pts/${pair.index}`,
    slave: pair.slave,
    write: data => { if (!closed) pair.slave.receive(typeof data === 'string' ? encoder.encode(data) : data.slice()) },
    onData: listener => { pair.listeners.add(listener); return () => { pair.listeners.delete(listener) } },
    resize: (cols, rows) => {
      if (closed) return
      pair.slave.winsize = { rows, cols }
      pair.slave.signal(Signal.WINCH)
    },
    close: () => { if (closed) return; closed = true; release(pair) }
  }
}

/** For tests and diagnostics: which slaves exist. */
export function ptyIndices(): number[] {
  return [...pairs.keys()].sort((a, b) => a - b)
}

type Handler = (proc: Process, ...args: unknown[]) => number | bigint | void | Promise<number | bigint | void>

/** Registers the drivers and the `/dev/ptmx` node, and wraps `open`, `close` and process exit. Idempotent. */
export function installPtys(): void {
  if (installed) return
  installed = true

  pts.register()
  masters.add({ major: MASTER_MAJOR, minor: 0 }, LINES)
  new CharDevice({}).add(PTMX, 1)
  ptmx = new Device({ name: 'ptmx', class: tty_class, dev_t: PTMX })
  ptmx.register()

  const open = syscalls.get('open' as never) as Handler | undefined
  if (open) {
    syscalls.set('open' as never, (async (proc: Process, path: unknown, ...rest: unknown[]) => {
      if (path === '/dev/ptmx') {
        const pair = allocate()
        try {
          const fd = await open(proc, `/dev${pair.masterPath}`, ...rest)
          pair.opened = true
          return fd
        } catch (error) {
          pair.opened = true
          release(pair)
          throw error
        }
      }
      // A process's own terminal, not the console's.
      if (path === '/dev/tty' && proc.tty) return await open(proc, ttyPathOf(proc.tty), ...rest)
      return await open(proc, path, ...rest)
    }) as never)
  }

  for (const name of ['close', 'dup2', 'dup3'] as const) {
    const original = syscalls.get(name as never) as Handler | undefined
    if (!original) continue
    syscalls.set(name as never, (async (proc: Process, ...args: unknown[]) => {
      try { return await original(proc, ...args) } finally { sweepPtys() }
    }) as never)
  }

  const exit = Process.prototype.exit
  Process.prototype.exit = function (this: Process, ...args: Parameters<typeof exit>) {
    try { return exit.apply(this, args) } finally { sweepPtys() }
  }
}
