/**
 * A pipe: a fixed-size ring buffer exposed as two `FileOperations` ends, the same interface
 * `@zenfs/linux`'s char devices already implement (`getDrivers` -> `KernelCharDevice.ops`).
 *
 * This is the Tier-1 prototype for U7 (pipe/poll). It deliberately stops short of minting real
 * numeric file descriptors: `@zenfs/core`'s fd table (`toFD`/`fromFD`) and `@zenfs/linux`'s
 * `Syscalls['pipe']` both want a `Process`/`FSContext` to hand descriptors to, and neither exists
 * in this kernel yet -- that lands with the `processes` branch (Tier 2). Until then, a pipe's two
 * ends are used directly wherever something needs a source/sink that behaves like a real pipe:
 * unit tests, and eventually the shell's own pipeline runner.
 *
 * Read semantics match a real Linux pipe:
 * - A read blocks (via `poll_wait`'s queue) until there is at least one byte, or the write end has
 *   closed.
 * - A read never blocks for the full requested length; it returns whatever is buffered (a short
 *   read), exactly like `read(2)` on a pipe.
 * - Once the write end has closed and the buffer is drained, a read returns 0 (EOF) rather than
 *   blocking forever.
 *
 * Write semantics:
 * - A write throws EPIPE once the read end has closed (SIGPIPE's ecmaOS-side effect belongs to a
 *   process model, so only the error propagates here).
 * - The buffer is unbounded: a real Linux pipe blocks a writer once its buffer (`PIPE_BUF`, 64KiB
 *   by default) is full. That backpressure is not implemented yet -- see the docs commit at the
 *   end of this branch.
 */

import { withErrno } from 'kerium'
import { EPOLLIN, EPOLLOUT } from '@zenfs/linux'
import { WaitQueue } from '@zenfs/linux'
import type { DeviceFile, FileOperations } from '@zenfs/linux'

class RingBuffer {
  private chunks: Uint8Array[] = []
  private length = 0

  get size(): number { return this.length }

  push(data: Uint8Array): void {
    if (data.byteLength === 0) return
    this.chunks.push(data)
    this.length += data.byteLength
  }

  /** Copy up to `into.byteLength` bytes out, in FIFO order, removing what was read. */
  shift(into: Uint8Array): number {
    let written = 0

    while (written < into.byteLength && this.chunks.length > 0) {
      const chunk = this.chunks[0] as Uint8Array
      const take = Math.min(chunk.byteLength, into.byteLength - written)
      into.set(chunk.subarray(0, take), written)
      written += take
      this.length -= take

      if (take === chunk.byteLength) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(take)
    }

    return written
  }
}

export interface Pipe {
  readEnd: FileOperations
  writeEnd: FileOperations
  /** The `DeviceFile` to pass as the first argument to `readEnd`'s operations */
  readFile: DeviceFile
  /** The `DeviceFile` to pass as the first argument to `writeEnd`'s operations */
  writeFile: DeviceFile
}

/** A `DeviceFile` isn't backed by a real inode here -- a pipe end never had a path to begin with. */
function pipeFile(path: string): DeviceFile {
  return {
    path,
    inode: { ino: 0, mode: 0, nlink: 1, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0, uid: 0, gid: 0 } as DeviceFile['inode'],
    devt: { major: 0, minor: 0 }
  }
}

/** Create a pipe: a ring buffer plus a `FileOperations` pair for its read and write ends. */
export function createPipe(): Pipe {
  const buffer = new RingBuffer()
  const readQueue = new WaitQueue()
  let readClosed = false
  let writeClosed = false

  const readEnd: FileOperations = {
    read: (_file, into) => {
      const n = buffer.shift(into)
      return n
    },
    poll: () => {
      if (buffer.size > 0 || writeClosed) return EPOLLIN
      return 0
    },
    poll_wait: () => readQueue,
    release: () => {
      readClosed = true
    }
  }

  const writeEnd: FileOperations = {
    write: (_file, data) => {
      if (readClosed) throw withErrno('EPIPE')
      buffer.push(data)
      readQueue.wake_up()
    },
    // A pipe with no bounded capacity yet (see the module doc) is always writable.
    poll: () => EPOLLOUT,
    release: () => {
      writeClosed = true
      readQueue.wake_up()
    }
  }

  return { readEnd, writeEnd, readFile: pipeFile('pipe:[read]'), writeFile: pipeFile('pipe:[write]') }
}
