/**
 * Sockets that are files: one descriptor a program reads, writes, polls, duplicates and hands to its children like any
 * other, for programs whose C library makes the socket calls itself (WALI's musl, through `bin/wali-host.mjs`).
 *
 * A connection is still the two directed pipes the loopback listeners and the gateway make (`net_connect`,
 * `net_connect_out`), so a socket here talks to a program that holds a connection as two descriptors (the emscripten
 * programs, `node`) just the same. The pipes' ends a socket uses are held in the kernel's own table (`holder`), where
 * the pipe file system counts them as open, and its reads, writes and polls go to them. When the last descriptor for
 * the socket closes, anywhere, they are closed too, and the other end sees the end of the stream.
 */

import { EPOLLIN, EPOLLOUT, processes, thread_of, wait_event, WaitQueue, type Process } from '@zenfs/linux'
import { PipeFS, pipefs } from '@zenfs/linux/fs/pipe'
import { Handle, toFD } from '@zenfs/core/vfs/file'
import { cacheOf } from '@zenfs/core/vfs/vcache'
import { O_NONBLOCK, O_RDWR, S_IFSOCK } from '@zenfs/core/constants'
import { Errno } from 'kerium'

const EPOLLHUP = 0x10
const MSG_PEEK = 0x2, MSG_DONTWAIT = 0x40

type Table = Map<number, Handle>
type PipeEnd = { pipe: { readable: number, writable: number, wait: WaitQueue, take(into: Uint8Array): number, buffer: Uint8Array }, write: boolean }
type DeviceFile = NonNullable<ReturnType<PipeFS['_device']>>

/** What a program's library keeps about a socket: its family, type and addresses, as it chooses to describe them */
export type SocketInfo = Record<string, unknown>

export interface Socket {
  id: number
  /** Whose table the pipes' ends are in, once the socket is connected */
  holder?: Process
  /** The read end of the pipe that brings data in, in the holder's table; gone after `shutdown(SHUT_RD)` */
  rx?: number
  /** The write end of the pipe that takes data out; gone after `shutdown(SHUT_WR)` */
  tx?: number
  connected: boolean
  /** The address it listens on, a loopback listener's key */
  listening?: string
  /** How many connections wait to be accepted */
  pending?: () => number
  info: SocketInfo
  /** Woken when the socket is connected or shut down, or a connection arrives for it to accept */
  wake: WaitQueue
  /** What else goes with the socket: its address, a gateway flow */
  cleanup: Array<() => void>
}

const fail = (errno: Errno, message: string) => Object.assign(new Error(message), { errno })

/** The file system socket files live on, never mounted; a socket is `/<id>` */
class SocketFS extends PipeFS {
  readonly sockets = new Map<number, Socket>()
  nextSocket = 1

  override _device(path: string, inode = this.statSync(path)): DeviceFile | undefined {
    const socket = this.sockets.get(idOf(path))
    return socket && ({ path, inode, devt: { major: 0, minor: socket.id }, ops: socketOps } as unknown as DeviceFile)
  }

  override read_device(file: DeviceFile, buffer: Uint8Array, start: number, end: number): number {
    return socketOps.read(file, buffer, start, end)
  }

  override write_device(file: DeviceFile, buffer: Uint8Array, offset: number): number {
    return socketOps.write(file, buffer.subarray(offset))
  }

  override readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
    const file = this._device(path)
    if (file) socketOps.read(file, buffer, start, end)
  }

  override writeSync(path: string, buffer: Uint8Array, offset: number): void {
    const file = this._device(path)
    if (file) socketOps.write(file, buffer.subarray(offset))
  }
}

export const socketfs = new SocketFS()

const idOf = (path: string) => Number(/^\/(\d+)$/.exec(path)?.[1])

function socketOfFile(file: { path: string }): Socket {
  const socket = socketfs.sockets.get(idOf(file.path))
  if (!socket) throw fail(Errno.EBADF, 'Bad file descriptor')
  return socket
}

/** One of a socket's pipe ends: its handle in the holder's table and what the pipe file system knows of it */
function endOf(socket: Socket, fd: number | undefined): { file: DeviceFile, end: PipeEnd } | undefined {
  if (fd === undefined || !socket.holder) return undefined
  const handle = (socket.holder.context.descriptors as unknown as Table).get(fd)
  if (!handle) return undefined
  const file = pipefs._device(handle.internalPath)
  const end = pipefs._end(handle.internalPath) as unknown as PipeEnd | undefined
  return file && end ? { file, end } : undefined
}

/** How many descriptors anywhere refer to a pipe end, as the pipe file system counts them */
function openEnds(path: string): number {
  let count = 0
  for (const proc of processes.values()) {
    for (const handle of proc.context.descriptors.values()) {
      if (handle.fs === pipefs && handle.internalPath === path) count++
    }
  }
  return count
}

/** The other end of a pipe end, by path: `/3.r` and `/3.w` */
const opposite = (path: string) => path.endsWith('.w') ? `${path.slice(0, -1)}r` : `${path.slice(0, -1)}w`

/** What a socket is ready for */
function readiness(socket: Socket): number {
  if (socket.listening) return socket.pending?.() ? EPOLLIN : 0
  // a call on a socket that is not connected fails at once with ENOTCONN, so there is nothing to wait for
  if (!socket.connected) return EPOLLIN | EPOLLOUT | EPOLLHUP
  let mask = 0
  const rx = endOf(socket, socket.rx), tx = endOf(socket, socket.tx)
  const writerGone = !rx || !openEnds(opposite(rx.file.path))
  if (!rx || rx.end.pipe.readable || writerGone) mask |= EPOLLIN
  const readerGone = !tx || !openEnds(opposite(tx.file.path))
  if (!tx || tx.end.pipe.writable || readerGone) mask |= EPOLLOUT
  if (writerGone && readerGone) mask |= EPOLLHUP
  return mask
}

/** Something to sleep on until the socket might be ready: its own queue and both pipes' */
function queueOf(socket: Socket): WaitQueue {
  return {
    wait_with(waiter: () => void) {
      const queues = [socket.wake, endOf(socket, socket.rx)?.end.pipe.wait, endOf(socket, socket.tx)?.end.pipe.wait]
      const stops = queues.map(queue => queue?.wait_with(waiter))
      return () => { for (const stop of stops) stop?.() }
    }
  } as unknown as WaitQueue
}

/** What a socket does, in the shape the read, write and poll syscalls look for on a device */
const socketOps = {
  read(file: { path: string }, buffer: Uint8Array, start: number, end: number): number {
    const socket = socketOfFile(file)
    if (!socket.connected) throw fail(Errno.ENOTCONN, 'Socket is not connected')
    const rx = endOf(socket, socket.rx)
    return rx ? pipefs.read_device(rx.file, buffer, start, end) : 0
  },
  write(file: { path: string }, buffer: Uint8Array): number {
    const socket = socketOfFile(file)
    if (!socket.connected) throw fail(Errno.ENOTCONN, 'Socket is not connected')
    const tx = endOf(socket, socket.tx)
    if (!tx) throw fail(Errno.EPIPE, 'Broken pipe')
    return pipefs.write_device(tx.file, buffer, 0)
  },
  poll: (file: { path: string }) => readiness(socketOfFile(file)),
  poll_wait: (file: { path: string }) => queueOf(socketOfFile(file))
}

/** A new socket, not yet connected, as a descriptor in `proc`'s table */
export function createSocket(proc: Process, flags = 0, info: SocketInfo = {}): { fd: number, socket: Socket } {
  const id = socketfs.nextSocket++
  const path = `/${id}`
  const socket: Socket = { id, connected: false, info, wake: new WaitQueue(), cleanup: [] }
  socketfs.sockets.set(id, socket)
  const inode = socketfs.createFileSync(path, { mode: S_IFSOCK | 0o777, uid: 0, gid: 0 })
  const handle = new Handle(proc.context, `socket:[${id}]`, path, O_RDWR | (flags & O_NONBLOCK), cacheOf(socketfs).ref(path, inode))
  return { fd: toFD(handle, proc.context), socket }
}

/** The socket a descriptor of `proc` is */
export function socketAt(proc: Process, fd: number): { socket: Socket, handle: Handle } {
  const handle = (proc.context.descriptors as unknown as Table).get(fd)
  if (!handle) throw fail(Errno.EBADF, 'Bad file descriptor')
  if (handle.fs !== socketfs) throw fail(Errno.ENOTSOCK, 'Socket operation on non-socket')
  return { socket: socketOfFile({ path: handle.internalPath }), handle }
}

/** Connects a socket to a pair of pipe ends in `holder`'s table: `rx` to read from and `tx` to write to */
export function attach(socket: Socket, holder: Process, rx: number, tx: number): void {
  Object.assign(socket, { holder, rx, tx, connected: true })
  socket.wake.wake_up()
}

/** Closes one of a socket's pipe ends, waking whatever waits on the pipe (the other end now sees it closed) */
function closeEnd(socket: Socket, fd: number | undefined): void {
  if (fd === undefined || !socket.holder) return
  const table = socket.holder.context.descriptors as unknown as Table
  const pipeOfEnd = endOf(socket, fd)?.end.pipe
  const handle = table.get(fd)
  table.delete(fd)
  try { handle?.closeSync() } catch { /* already closed */ }
  pipeOfEnd?.wait.wake_up()
}

/** `shutdown(2)`: `how` 0 stops reading, 1 writing (the other end reads the end of the stream), 2 both */
export function shutdown(socket: Socket, how: number): void {
  if (!socket.connected) throw fail(Errno.ENOTCONN, 'Socket is not connected')
  if (how < 0 || how > 2) throw fail(Errno.EINVAL, 'Invalid argument')
  if (how !== 1) { closeEnd(socket, socket.rx); socket.rx = undefined }
  if (how !== 0) { closeEnd(socket, socket.tx); socket.tx = undefined }
  socket.wake.wake_up()
}

/** `recv(2)` with its flags: `MSG_PEEK` leaves the data where it is, `MSG_DONTWAIT` does not wait for any */
export async function receive(proc: Process, fd: number, count: number, flags: number): Promise<number> {
  const { socket, handle } = socketAt(proc, fd)
  if (!socket.connected) throw fail(Errno.ENOTCONN, 'Socket is not connected')
  const ready = () => {
    const rx = endOf(socket, socket.rx)
    return !rx || rx.end.pipe.readable > 0 || !openEnds(opposite(rx.file.path))
  }
  if (!ready()) {
    if ((handle.flag & O_NONBLOCK) || (flags & MSG_DONTWAIT)) throw fail(Errno.EAGAIN, 'Resource temporarily unavailable')
    await wait_event(queueOf(socket), ready, proc)
  }
  const { region } = thread_of(proc)
  const into = region.subarray(0, Math.min(count, region.byteLength))
  const rx = endOf(socket, socket.rx)
  if (!rx) return thread_of(proc).filled(0)
  if (!(flags & MSG_PEEK)) return thread_of(proc).filled(rx.end.pipe.take(into))
  const held = rx.end.pipe.buffer
  const length = Math.min(into.byteLength, held.byteLength)
  into.set(held.subarray(0, length))
  return thread_of(proc).filled(length)
}

/** `send(2)` with `MSG_DONTWAIT`: a full pipe is EAGAIN rather than a wait */
export async function send(proc: Process, fd: number, data: Uint8Array, flags: number): Promise<number> {
  const { socket, handle } = socketAt(proc, fd)
  if (!socket.connected) throw fail(Errno.ENOTCONN, 'Socket is not connected')
  const ready = () => !!(readiness(socket) & EPOLLOUT)
  if (!ready()) {
    if ((handle.flag & O_NONBLOCK) || (flags & MSG_DONTWAIT)) throw fail(Errno.EAGAIN, 'Resource temporarily unavailable')
    await wait_event(queueOf(socket), ready, proc)
  }
  return socketOps.write({ path: handle.internalPath }, data)
}

/** Waits for a listening socket to have a connection waiting, unless it is non-blocking */
export async function whenPending(proc: Process, socket: Socket, handle: Handle): Promise<void> {
  if (socket.pending?.()) return
  if (handle.flag & O_NONBLOCK) throw fail(Errno.EAGAIN, 'Resource temporarily unavailable')
  await wait_event(queueOf(socket), () => !!socket.pending?.(), proc)
}

/** Lets go of a socket no descriptor refers to any more: its pipe ends, its address, and its file */
function release(socket: Socket): void {
  closeEnd(socket, socket.rx)
  closeEnd(socket, socket.tx)
  for (const cleanup of socket.cleanup) { try { cleanup() } catch { /* best effort */ } }
  socketfs.sockets.delete(socket.id)
  const path = `/${socket.id}`
  const cache = cacheOf(socketfs)
  const node = cache.get(path)
  if (node) node.refs = 0
  cache.remove(path)
  try { socketfs.unlinkSync(path) } catch { /* already gone */ }
}

/** Releases every socket no table refers to; run after anything that closes descriptors */
export function sweepSockets(): void {
  if (!socketfs.sockets.size) return
  const open = new Set<number>()
  for (const proc of processes.values()) {
    for (const handle of proc.context.descriptors.values()) {
      if (handle.fs === socketfs) open.add(idOf(handle.internalPath))
    }
  }
  for (const socket of [...socketfs.sockets.values()]) if (!open.has(socket.id)) release(socket)
}

/** A socket's information with what the kernel knows of it, for `getsockname`, `getpeername` and `FIONREAD` */
export function describe(socket: Socket): SocketInfo {
  const rx = endOf(socket, socket.rx)
  return { ...socket.info, connected: socket.connected, listening: !!socket.listening, readable: rx?.end.pipe.readable ?? 0 }
}
