/**
 * Named pipes. `mkfifo(3)` and `mknod(2)` make a node of type `S_IFIFO` in the file system; opening it gives a descriptor
 * on a pipe that every opener of that node shares. `@zenfs/linux` has pipes (`pipefs`) but no names for them, so the
 * node is an ordinary inode that carries the type, and {@link bindFifo} swaps the descriptor `open` made for one on a
 * pipe's end, the way `fifo_open` does. The pipe lives as long as some descriptor anywhere holds one of its ends; when
 * the last one closes, whatever it held is dropped, as in Linux, and the next open starts a fresh pipe.
 */

import { boundContexts } from '@zenfs/core'
import { O_NONBLOCK, O_RDWR, O_WRONLY, S_IFBLK, S_IFCHR, S_IFIFO, S_IFMT, S_IFREG, S_IFSOCK } from '@zenfs/core/constants'
import { Handle } from '@zenfs/core/vfs/file'
import { resolveMount } from '@zenfs/core/vfs/shared'
import { cacheOf } from '@zenfs/core/vfs/vcache'
import { processes, type Process } from '@zenfs/linux'
import { EPOLLIN, EPOLLOUT } from '@zenfs/linux/fs/devtmpfs'
import { pipefs } from '@zenfs/linux/fs/pipe'
import { withErrno } from 'kerium'

type Context = ConstructorParameters<typeof Handle>[0]
type Vnode = ConstructorParameters<typeof Handle>[4]
type Created = ReturnType<typeof pipefs.create>
type Descriptor = Handle & { flag: number, disposeSync(force?: boolean): void }

interface Fifo extends Created {
  /** The ends held for descriptors that are open for both reading and writing, so that the pipe has a reader and a writer for as long as they are */
  keepers?: Array<{ table: Map<number, Handle>, key: number, handle: Handle }>
  /** How many read-write descriptors rely on `keepers` */
  readWrite: number
}

/** The pipe of each node, by file system and inode (a file system is met through wrappers, so it is told by its uuid) */
const fifos = new Map<string, Fifo>()
const readPath = (id: number) => `/${id}.r`
const bothPath = (id: number) => `/${id}.rw`
const writePath = (id: number) => `/${id}.w`

/** The number of descriptors in any process that hold the end at `path` */
function holders(path: string): number {
  let count = 0
  for (const proc of processes.values()) {
    for (const handle of proc.context.descriptors.values()) {
      if (handle.fs === pipefs && handle.internalPath === path) count++
    }
  }
  return count
}

/** Runs `after` once, when `handle` has been closed by the last descriptor for it (the file API closes with `dispose`, the syscalls with `disposeSync`) */
function whenClosed(handle: Descriptor, after: () => void): void {
  let ran = false
  for (const name of ['disposeSync', 'dispose'] as const) {
    const original = (handle as unknown as Record<string, (force?: boolean) => unknown>)[name]
    if (typeof original !== 'function') continue
    ;(handle as unknown as Record<string, unknown>)[name] = function (this: Descriptor, force?: boolean) {
      const result = original.call(this, force)
      if (this.isClosed && !ran) { ran = true; after() }
      return result
    }
  }
}

/**
 * Keeps a pipe end open for `holder` for as long as `handle` is: the pipe's ends are counted in the tables of the
 * processes, which is how a reader learns that no writer is left, and a descriptor the shell holds is in no process's
 * table. The kernel's own process holds the other end, out of every program's way, and lets go when `handle` closes.
 */
function shadow(holder: Process, handle: Descriptor, fifo: Fifo, write: boolean): void {
  const table = holder.context.descriptors as unknown as Map<number, Handle>
  let key = 0
  while (table.has(key)) key++
  const held = endHandle(holder.context as unknown as Context, fifo, write, handle.flag)
  table.set(key, held)
  whenClosed(handle, () => {
    if (table.get(key) === held) table.delete(key)
    held.closeSync()
  })
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The pipe behind a node, a new one when nothing holds the old one open any more (or it was swept) */
function pipeOf(fs: { uuid: string }, ino: number): Fifo {
  const key = `${fs.uuid}:${ino}`
  const known = fifos.get(key)
  const live = known && (pipefs as unknown as { pipes: Map<number, unknown> }).pipes.has(known.pipe.id)
    && (holders(readPath(known.pipe.id)) > 0 || holders(writePath(known.pipe.id)) > 0)
  if (live) return known
  const made: Fifo = { ...pipefs.create(), readWrite: 0 }
  fifos.set(key, made)
  return made
}

const endHandle = (context: Context, fifo: Fifo, write: boolean, flag: number) => {
  const path = write ? writePath(fifo.pipe.id) : readPath(fifo.pipe.id)
  return new Handle(context, `pipe:[${fifo.pipe.id}]`, path, flag, cacheOf(pipefs).ref(path, write ? fifo.write : fifo.read) as Vnode)
}

/** The descriptor for a pipe opened for both reading and writing, which is neither of the two ends but both */
const bothHandle = (context: Context, fifo: Fifo, flag: number) => {
  const path = bothPath(fifo.pipe.id)
  return new Handle(context, `pipe:[${fifo.pipe.id}]`, path, flag, cacheOf(pipefs).ref(path, fifo.read) as Vnode)
}

type Pipe = Created['pipe']
type Device = { path: string, inode: unknown, devt: { major: number, minor: number }, ops: typeof duplexOps }
const pipeOfPath = (path: string): Pipe | undefined => {
  const id = /^\/(\d+)\.rw$/.exec(path)?.[1]
  return id === undefined ? undefined : (pipefs as unknown as { pipes: Map<number, Pipe> }).pipes.get(Number(id))
}

/** What a descriptor open for both reading and writing does: it reads and writes the one pipe, and is ready for either */
const duplexOps = {
  read: (file: Device, buffer: Uint8Array, start: number, end: number) => pipeOfPath(file.path)?.take(buffer.subarray(start, end)) ?? 0,
  write: (file: Device, buffer: Uint8Array) => pipeOfPath(file.path)?.put(buffer) ?? 0,
  poll: (file: Device) => {
    const pipe = pipeOfPath(file.path)
    return pipe ? (pipe.readable ? EPOLLIN : 0) | (pipe.writable ? EPOLLOUT : 0) : 0
  },
  poll_wait: (file: Device) => pipeOfPath(file.path)?.wait
}

let duplexInstalled = false
/** Teaches the pipe file system the `/N.rw` descriptors above, whose operations are not the pipe ends' */
function installDuplex(): void {
  if (duplexInstalled) return
  duplexInstalled = true
  const target = pipefs as unknown as Record<string, (this: unknown, ...args: never[]) => unknown>
  const device = target['_device']!
  const readDevice = target['read_device']!
  const writeDevice = target['write_device']!
  const readSync = target['readSync']!
  const writeSync = target['writeSync']!
  target['_device'] = function (this: unknown, path: string, inode?: unknown) {
    if (!pipeOfPath(path)) return device.call(this, path as never, inode as never)
    return { path, inode, devt: { major: 0, minor: Number(/^\/(\d+)/.exec(path)![1]) }, ops: duplexOps }
  } as never
  target['read_device'] = function (this: unknown, file: Device, ...rest: unknown[]) {
    return file.ops === duplexOps ? duplexOps.read(file, ...(rest as [Uint8Array, number, number])) : readDevice.call(this, file as never, ...rest as never[])
  } as never
  target['write_device'] = function (this: unknown, file: Device, ...rest: unknown[]) {
    return file.ops === duplexOps ? duplexOps.write(file, ...(rest as [Uint8Array])) : writeDevice.call(this, file as never, ...rest as never[])
  } as never
  target['readSync'] = function (this: unknown, path: string, ...rest: unknown[]) {
    return pipeOfPath(path) ? duplexOps.read({ path } as Device, ...(rest as [Uint8Array, number, number])) : readSync.call(this, path as never, ...rest as never[])
  } as never
  target['writeSync'] = function (this: unknown, path: string, ...rest: unknown[]) {
    return pipeOfPath(path) ? void duplexOps.write({ path } as Device, ...(rest as [Uint8Array])) : writeSync.call(this, path as never, ...rest as never[])
  } as never
}

/**
 * Replaces the descriptor `fd`, which `open` made on the node, with one on the node's pipe. Opening for reading waits for
 * a writer and opening for writing waits for a reader (`ENXIO` when `O_NONBLOCK`), and read-write never waits.
 * @returns whether `fd` was a named pipe
 */
export async function bindFifo(proc: Process, fd: number, holder: Process): Promise<boolean> {
  return bindFifoIn(proc.context as unknown as Context & { descriptors: Map<number, Handle> }, fd, holder, true)
}

/**
 * {@link bindFifo} for a context that is not a process (the shell's): `holder` is a process that stands in for it in the
 * count of who has the pipe open, as {@link shadow} says
 */
export async function bindFifoIn(context: Context & { descriptors: Map<number, Handle> }, fd: number, holder: Process, isProcess = false): Promise<boolean> {
  const descriptors = context.descriptors
  const opened = descriptors.get(fd) as Descriptor | undefined
  if (!opened || opened.fs === pipefs || (opened.inode.mode & S_IFMT) !== S_IFIFO) return false

  const fifo = pipeOf(opened.fs, opened.inode.ino)
  const access = opened.flag & 3
  const nonBlocking = (opened.flag & O_NONBLOCK) !== 0
  const write = access === O_WRONLY
  const duplex = access === O_RDWR

  installDuplex()
  const handle = (duplex ? bothHandle(context, fifo, opened.flag) : endHandle(context, fifo, write, opened.flag)) as Descriptor
  if (!isProcess) {
    if (duplex) { shadow(holder, handle, fifo, false); shadow(holder, handle, fifo, true) } else shadow(holder, handle, fifo, write)
  }
  if (duplex) {
    // a reader and a writer for the pipe's other descriptors to find, for as long as this one is open
    if (!fifo.readWrite++) {
      fifo.keepers = [false, true].map(end => {
        const table = holder.context.descriptors as unknown as Map<number, Handle>
        let key = 0
        while (table.has(key)) key++
        const kept = endHandle(holder.context as unknown as Context, fifo, end, end ? O_WRONLY : 0)
        table.set(key, kept)
        return { table, key, handle: kept }
      })
    }
    whenClosed(handle, () => {
      if (--fifo.readWrite) return
      for (const { table, key, handle: kept } of fifo.keepers ?? []) { table.delete(key); kept.closeSync() }
      fifo.keepers = undefined
    })
  }
  descriptors.set(fd, handle)
  try { opened.closeSync() } catch { /* the node's own handle has nothing to flush */ }

  if (!duplex && !nonBlocking) {
    const other = write ? readPath(fifo.pipe.id) : writePath(fifo.pipe.id)
    while (!holders(other)) {
      if (handle.isClosed) break
      await sleep(5)
    }
  } else if (write && !duplex && !holders(readPath(fifo.pipe.id))) {
    descriptors.delete(fd)
    handle.closeSync()
    throw withErrno('ENXIO')
  }
  return true
}

/** The operations of the pipe end that `fd` is, or nothing when it is not one */
function endOf(context: { descriptors: Map<number, Handle> }, fd: number) {
  const handle = context.descriptors.get(fd)
  return handle && handle.fs === pipefs ? pipefs._device(handle.internalPath) : undefined
}

/**
 * A read of the named pipe `fd` for a caller that reads through the file API, which would not wait: the file system's
 * asynchronous calls do not know a pipe's ends. Waits while the pipe is empty and a writer is still there.
 * @returns the bytes read, 0 at the end of the stream
 */
export async function fifoRead(context: { descriptors: Map<number, Handle> }, fd: number, into: Uint8Array): Promise<number> {
  for (;;) {
    const end = endOf(context, fd)
    if (!end) return 0
    const count = pipefs.read_device(end, into, 0, into.byteLength)
    if (count > 0) return count
    const mine = context.descriptors.get(fd)!.internalPath
    if (!holders(mine.slice(0, -1) + (mine.endsWith('.r') ? 'w' : 'r'))) return 0
    await sleep(5)
  }
}

/**
 * A write to the named pipe `fd` for a caller that writes through the file API: all of `data`, waiting while the pipe is
 * full. Fails with `EPIPE` when nothing is left to read it.
 */
export async function fifoWrite(context: { descriptors: Map<number, Handle> }, fd: number, data: Uint8Array): Promise<void> {
  for (let done = 0; done < data.byteLength;) {
    const end = endOf(context, fd)
    if (!end) throw withErrno('EBADF')
    const count = pipefs.write_device(end, data.subarray(done), 0)
    done += count
    if (!count) await sleep(5)
  }
}

/**
 * `mknod(2)` for the kinds a program can make without a device behind them: a regular file or a named pipe. Device nodes
 * need privilege (and a driver) and a socket node is what `bind` makes, so those are refused.
 */
export async function makeNode(proc: Process, path: string, mode: number, umask: number): Promise<number> {
  const kind = (mode & S_IFMT) || S_IFREG
  if (kind === S_IFCHR || kind === S_IFBLK) throw withErrno('EPERM')
  if (kind !== S_IFREG && kind !== S_IFIFO) throw withErrno('EINVAL', kind === S_IFSOCK ? 'a socket node is made by bind(2)' : undefined)
  const bound = boundContexts.get(proc.context.id)
  if (!bound) throw withErrno('EPERM')
  const permissions = mode & 0o7777 & ~umask
  await (await bound.fs.promises.open(path, 'wx', permissions)).close()
  if (kind === S_IFIFO) {
    // the file system gives every file it creates the regular type, so the node takes its own type after it exists
    const { fs, cache, path: inner } = resolveMount(path, proc.context)
    try {
      await fs.touch(inner, { mode: S_IFIFO | permissions })
    } catch (error) {
      await bound.fs.promises.unlink(path).catch(() => {})
      throw error
    }
    cache.remove(inner)
  }
  return 0
}
