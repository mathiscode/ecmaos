/**
 * Sockets that are files: one descriptor a program reads, writes, polls, duplicates and hands to its children like any
 * other, for programs whose C library makes the socket calls itself (WALI's musl, through `bin/wali-host.mjs`).
 *
 * A connection is still the two directed pipes the loopback listeners and the gateway make (`net_connect`,
 * `net_connect_out`), so a socket here talks to a program that holds a connection as two descriptors (the emscripten
 * programs, `node`) just the same. The pipes' ends a socket uses are held in the kernel's own table (`holder`), where
 * the pipe file system counts them as open, and its reads, writes and polls go to them. When the last descriptor for
 * the socket closes, anywhere, they are closed too, and the other end sees the end of the stream.
 *
 * Descriptors sent with `SCM_RIGHTS` travel beside the bytes of a local connection: each pipe keeps the ones sent with
 * the messages still in it, by the byte offset each message starts at, and a read stops at the edges of such a message
 * as Linux's does. A descriptor in flight is an extra reference to its open file, kept in the kernel's own table, so a
 * pipe whose write end is on its way somewhere is not at its end, and a socket on its way is not let go.
 *
 * A datagram socket has no pipes: what arrives for it waits in a queue of whole datagrams, each with its sender, and
 * what it sends goes to the UDP port it holds (`udp-ports.ts`), which carries it to another program's port or out
 * through the gateway.
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
  /** A datagram socket's side: set when it is opened as one */
  datagrams?: Datagrams
  /**
   * Set when the other end is an emcc program, whose descriptors travel beside the stream rather than in its pipe
   * (`scm_send`, `scm_take`): takes the descriptors sent with the `length` bytes `offset` bytes into the stream
   */
  rightsToPeer?: (handles: Handle[], offset: number, length: number) => void
}

/** One datagram and who sent it */
export interface Datagram { addr: string, port: number, data: Uint8Array }

export interface Datagrams {
  /** What came in, oldest first, not read yet */
  queue: Datagram[]
  /** Sends one datagram from the socket's port; there once the socket has one */
  send?: (addr: string, port: number, data: Uint8Array) => void
}

/** A descriptor on its way: its open file, referenced once more in `holder`'s table under `key` */
interface InFlight { holder: Process, key: number }

/** The descriptors sent with the `length` bytes starting `offset` bytes into a pipe */
interface Rights { offset: number, length: number, held: InFlight[] }

/** What a pipe of a local connection carries besides its bytes: how much has been read of it, and the descriptors sent with what is still in it, oldest first */
interface Ancillary { taken: number, rights: Rights[] }

/** Each pipe's, by the pipe both its ends share; a pipe with no descriptors in it has none */
const ancillary = new WeakMap<PipeEnd['pipe'], Ancillary>()

/** Where in-flight descriptors go in the holder's table: far above any number a program is given */
let nextInFlight = 0x50000000

/** The most descriptors in flight on one pipe, as Linux's `SCM_MAX_FD` limits one message */
const MaxInFlight = 253

const InFlightHandle = (held: InFlight) => (held.holder.context.descriptors as unknown as Table).get(held.key)

/** Lets go of descriptors that will not be received */
function drop(held: InFlight[]): void {
  for (const one of held) {
    const handle = InFlightHandle(one)
    ;(one.holder.context.descriptors as unknown as Table).delete(one.key)
    try { handle?.closeSync() } catch { /* already closed */ }
  }
}

/**
 * Bytes from a connection's pipe into `into`, as one read takes them: never past the end of a message that carried
 * descriptors, nor into the next one that does. The descriptors of the message the read starts at come back with it
 * (none for a peek); those of a message an earlier read passed over are let go.
 */
function takeFrom(pipe: PipeEnd['pipe'], into: Uint8Array, peek: boolean): { length: number, rights?: Rights } {
  const state = ancillary.get(pipe)
  let limit = into.byteLength
  let first: Rights | undefined
  if (state) {
    while (state.rights[0] && state.rights[0].offset < state.taken) drop(state.rights.shift()!.held)
    if (state.rights[0]?.offset === state.taken) { first = state.rights[0]; limit = Math.min(limit, first.length) }
    else if (state.rights[0]) limit = Math.min(limit, state.rights[0].offset - state.taken)
  }
  const part = into.subarray(0, limit)
  if (peek) {
    const length = Math.min(part.byteLength, pipe.buffer.byteLength)
    part.set(pipe.buffer.subarray(0, length))
    return { length }
  }
  const length = pipe.take(part)
  if (!state) return { length }
  state.taken += length
  if (length && first) state.rights.shift()
  if (!state.rights.length) ancillary.delete(pipe)
  return { length, rights: length ? first : undefined }
}

/** Lets go of every descriptor still in flight in a pipe */
function dropAll(pipe: PipeEnd['pipe'] | undefined): void {
  const state = pipe && ancillary.get(pipe)
  if (!state) return
  for (const rights of state.rights) drop(rights.held)
  ancillary.delete(pipe)
}

/** How many datagrams wait to be read before more are dropped, as a full receive buffer drops them */
const DatagramQueueLimit = 256

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
  // a datagram can always be sent (one with no room on the way is dropped, not waited for)
  if (socket.datagrams) return EPOLLOUT | (socket.datagrams.queue.length ? EPOLLIN : 0)
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
    if (socket.datagrams) {
      // one datagram per read, cut to the room there is
      const next = socket.datagrams.queue.shift()
      if (!next) throw fail(Errno.EAGAIN, 'Resource temporarily unavailable')
      const length = Math.min(next.data.byteLength, end - start)
      buffer.set(next.data.subarray(0, length), start)
      return length
    }
    if (!socket.connected) throw fail(Errno.ENOTCONN, 'Socket is not connected')
    const rx = endOf(socket, socket.rx)
    if (!rx) return 0
    // a plain read takes no descriptors: those sent with what it reads are let go
    const { length, rights } = takeFrom(rx.end.pipe, buffer.subarray(start, end), false)
    if (rights) drop(rights.held)
    return length
  },
  write(file: { path: string }, buffer: Uint8Array): number {
    const socket = socketOfFile(file)
    if (socket.datagrams) return sendDatagram(socket, undefined, buffer)
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
  // descriptors sent to a socket that will read no more are never received
  if (fd === socket.rx) dropAll(pipeOfEnd)
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
  if (socket.datagrams) {
    const { data } = await receiveDatagram(proc, fd, flags)
    const { region } = thread_of(proc)
    const length = Math.min(data.byteLength, count, region.byteLength)
    region.set(data.subarray(0, length))
    return thread_of(proc).filled(length)
  }
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
  const { length, rights } = takeFrom(rx.end.pipe, into, (flags & MSG_PEEK) !== 0)
  if (rights) drop(rights.held)
  return thread_of(proc).filled(length)
}

/** Whether a socket can carry descriptors: a stream between programs on this machine (`AF_UNIX`) */
const carriesRights = (socket: Socket) => !socket.datagrams && (socket.info.family === 1 || socket.info.family === 'unix')

/**
 * `sendmsg(2)` with `SCM_RIGHTS`: sends `data` with the descriptors `fds` of `proc`, which the other end gets with the
 * first read of these bytes. Until then each is held in `holder`'s table (the kernel's process, which outlives the
 * sender). @returns the bytes sent
 */
export async function sendRights(proc: Process, fd: number, data: Uint8Array, fds: number[], holder: Process, flags: number): Promise<number> {
  const { socket, handle } = socketAt(proc, fd)
  if (!carriesRights(socket)) throw fail(Errno.EINVAL, 'Invalid argument')
  if (!socket.connected) throw fail(Errno.ENOTCONN, 'Socket is not connected')
  const table = proc.context.descriptors as unknown as Table
  const handles = fds.map(one => table.get(one))
  if (handles.some(one => !one)) throw fail(Errno.EBADF, 'Bad file descriptor')
  const ready = () => !!(readiness(socket) & EPOLLOUT)
  if (!ready()) {
    if ((handle.flag & O_NONBLOCK) || (flags & MSG_DONTWAIT)) throw fail(Errno.EAGAIN, 'Resource temporarily unavailable')
    await wait_event(queueOf(socket), ready, proc)
  }
  const tx = endOf(socket, socket.tx)
  if (!tx) throw fail(Errno.EPIPE, 'Broken pipe')
  const pipe = tx.end.pipe
  if (socket.rightsToPeer) {
    const offset = written.get(pipe) ?? 0
    const length = socketOps.write({ path: handle.internalPath }, data)
    if (length) socket.rightsToPeer(handles as Handle[], offset, length)
    return length
  }
  const state = ancillary.get(pipe) ?? { taken: 0, rights: [] }
  if (state.rights.reduce((sum, rights) => sum + rights.held.length, 0) + handles.length > MaxInFlight) throw fail(Errno.ETOOMANYREFS, 'Too many references')
  const offset = state.taken + pipe.readable
  const length = socketOps.write({ path: handle.internalPath }, data)
  if (!length) return 0
  const held = handles.map(one => {
    const key = nextInFlight++
    ;(holder.context.descriptors as unknown as Table).set(key, (one as unknown as { ref(): Handle }).ref())
    return { holder, key }
  })
  state.rights.push({ offset, length, held })
  ancillary.set(pipe, state)
  return length
}

/** How much has gone into each pipe that counts it (`countWritten`) */
const written = new WeakMap<PipeEnd['pipe'], number>()

/**
 * Has a connected socket count what it writes, from now on, for a peer that names its descriptors by where they are
 * in the stream (an emcc program: `rightsToPeer`). The pipe is the connection's own, so nothing was written to it
 * before.
 */
export function countWritten(socket: Socket): void {
  const pipe = endOf(socket, socket.tx)?.end.pipe as (PipeEnd['pipe'] & { put(data: Uint8Array): number }) | undefined
  if (!pipe || written.has(pipe)) return
  written.set(pipe, 0)
  const put = pipe.put.bind(pipe)
  pipe.put = data => {
    const length = put(data)
    written.set(pipe, (written.get(pipe) ?? 0) + length)
    return length
  }
}

/**
 * Descriptors an emcc program sends to this socket (`scm_send`), with `length` bytes it is about to write (or that
 * start `offset` bytes into the stream, when none of it has been read): they go with those bytes as `sendRights` would
 * put them, held in `holder`'s table until received.
 */
export function rightsFromPeer(socket: Socket, handles: Handle[], length: number, holder: Process, offset?: number): void {
  const pipe = endOf(socket, socket.rx)?.end.pipe
  if (!pipe) {
    for (const one of handles) { try { one.closeSync() } catch { /* already closed */ } }
    return
  }
  const state = ancillary.get(pipe) ?? { taken: 0, rights: [] }
  const held = handles.map(one => {
    const key = nextInFlight++
    ;(holder.context.descriptors as unknown as Table).set(key, one)
    return { holder, key }
  })
  state.rights.push({ offset: offset ?? state.taken + pipe.readable, length, held })
  state.rights.sort((a, b) => a.offset - b.offset)
  ancillary.set(pipe, state)
}

/** What comes before the data `receiveRights` puts in the region: the count of descriptors (4), flags (4: 1 when some were cut, 2 when credentials follow), the sender's pid, uid and gid (12), then the descriptors (4 each) */
export const RightsHeader = 20
const RightsCut = 1, RightsCredentials = 2

/**
 * `recvmsg(2)` on a local stream: the next bytes, as `receive` gives them, with the descriptors sent with them put in
 * `proc`'s table (the lowest free numbers), up to `room` of them; the rest are let go, and the flags say so. With
 * `SO_PASSCRED` on, the peer's credentials come too.
 */
export async function receiveRights(proc: Process, fd: number, count: number, flags: number, room: number): Promise<number> {
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
  const answer = new DataView(region.buffer, region.byteOffset)
  region.fill(0, 0, RightsHeader)
  const rx = endOf(socket, socket.rx)
  // the descriptors go after the header, so the data starts after the most there could be
  const dataAt = RightsHeader + 4 * MaxInFlight
  const { length, rights } = rx ? takeFrom(rx.end.pipe, region.subarray(dataAt, dataAt + Math.max(0, Math.min(count, region.byteLength - dataAt))), (flags & MSG_PEEK) !== 0) : { length: 0 }
  const held = rights?.held ?? []
  const given = held.slice(0, Math.max(room, 0))
  drop(held.slice(given.length))
  const table = proc.context.descriptors as unknown as Table
  let next = 0
  given.forEach((one, i) => {
    const moving = InFlightHandle(one)
    ;(one.holder.context.descriptors as unknown as Table).delete(one.key)
    while (table.has(next)) next++
    if (moving) table.set(next, moving)
    answer.setInt32(RightsHeader + 4 * i, moving ? next : -1, true)
  })
  answer.setUint32(0, given.length, true)
  const cred = socket.info.passcred ? socket.info.peercred as { pid: number, uid: number, gid: number } | undefined : undefined
  answer.setUint32(4, (held.length > given.length ? RightsCut : 0) | (cred ? RightsCredentials : 0), true)
  if (cred) { answer.setInt32(8, cred.pid, true); answer.setInt32(12, cred.uid, true); answer.setInt32(16, cred.gid, true) }
  // the data follows the descriptors given
  region.copyWithin(RightsHeader + 4 * given.length, dataAt, dataAt + length)
  return thread_of(proc).filled(RightsHeader + 4 * given.length + length)
}

/** `send(2)` with `MSG_DONTWAIT`: a full pipe is EAGAIN rather than a wait */
export async function send(proc: Process, fd: number, data: Uint8Array, flags: number): Promise<number> {
  const { socket, handle } = socketAt(proc, fd)
  if (socket.datagrams) return sendDatagram(socket, undefined, data)
  if (!socket.connected) throw fail(Errno.ENOTCONN, 'Socket is not connected')
  const ready = () => !!(readiness(socket) & EPOLLOUT)
  if (!ready()) {
    if ((handle.flag & O_NONBLOCK) || (flags & MSG_DONTWAIT)) throw fail(Errno.EAGAIN, 'Resource temporarily unavailable')
    await wait_event(queueOf(socket), ready, proc)
  }
  return socketOps.write({ path: handle.internalPath }, data)
}

/** The largest datagram: what a UDP length field holds, less the UDP and IPv4 headers */
const MaxDatagram = 65507

/** The address a datagram socket's peer was fixed at by `connect`, if it was */
const peerOf = (socket: Socket) => socket.info.peer as { addr: string, port: number } | undefined

/**
 * Sends one datagram from a datagram socket to `to`, or to its peer when `to` is undefined. The socket has a port by
 * now (the caller binds one first). @returns the bytes sent
 */
export function sendDatagram(socket: Socket, to: { addr: string, port: number } | undefined, data: Uint8Array): number {
  const target = to ?? peerOf(socket)
  if (!target) throw fail(Errno.EDESTADDRREQ, 'Destination address required')
  if (data.byteLength > MaxDatagram) throw fail(Errno.EMSGSIZE, 'Message too long')
  if (!socket.datagrams?.send) throw fail(Errno.EDESTADDRREQ, 'Destination address required')
  socket.datagrams.send(target.addr, target.port, data.slice())
  return data.byteLength
}

/**
 * A datagram that arrived for a socket: kept unless the queue is full or the socket's peer is fixed and it is not the
 * sender (a connected UDP socket hears only from its peer). Loopback addresses match one another, as the sender of a
 * datagram from this machine is named by the address it was sent to.
 */
export function deliverDatagram(socket: Socket, datagram: Datagram): void {
  const datagrams = socket.datagrams
  if (!datagrams || datagrams.queue.length >= DatagramQueueLimit) return
  const peer = peerOf(socket)
  const loopback = (addr: string) => addr === '127.0.0.1' || addr === '::1'
  if (peer && (peer.port !== datagram.port || (peer.addr !== datagram.addr && !(loopback(peer.addr) && loopback(datagram.addr))))) return
  datagrams.queue.push(datagram)
  socket.wake.wake_up()
}

/** `recvfrom(2)` on a datagram socket: the next datagram, waiting for one unless told not to; `MSG_PEEK` leaves it */
export async function receiveDatagram(proc: Process, fd: number, flags: number): Promise<Datagram> {
  const { socket, handle } = socketAt(proc, fd)
  const datagrams = socket.datagrams
  if (!datagrams) throw fail(Errno.EINVAL, 'Invalid argument')
  if (!datagrams.queue.length) {
    if ((handle.flag & O_NONBLOCK) || (flags & MSG_DONTWAIT)) throw fail(Errno.EAGAIN, 'Resource temporarily unavailable')
    await wait_event(queueOf(socket), () => datagrams.queue.length > 0, proc)
  }
  return (flags & MSG_PEEK ? datagrams.queue[0] : datagrams.queue.shift())!
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
  // what FIONREAD tells: for a datagram socket, the size of the next datagram
  if (socket.datagrams) return { ...socket.info, connected: !!peerOf(socket), listening: false, readable: socket.datagrams.queue[0]?.data.byteLength ?? 0 }
  const rx = endOf(socket, socket.rx)
  return { ...socket.info, connected: socket.connected, listening: !!socket.listening, readable: rx?.end.pipe.readable ?? 0 }
}
