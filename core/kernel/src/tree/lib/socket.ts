/**
 * A socket: a `WebSocket`-backed `FileOperations` end, in the same shape `lib/pipe.ts` uses for
 * pipes -- and for the identical reason. Real `socket()`/`connect()`/`send()`/`recv()` syscalls
 * (Phase 6's target, `.docs/overhaul/09-phase-6-security.md`) want a numeric fd minted through a
 * `Process`'s fd table, and that table does not exist yet in this kernel: `Process` still carries
 * no file-descriptor concept of its own (the same gap that stopped `lib/pipe.ts` from registering
 * a real `pipe` syscall). Until that plumbing lands, a socket's `FileOperations` end is used
 * directly wherever something needs a byte-stream-with-readiness: unit tests today, and the
 * `socket`/`connect`/`send`/`recv` syscall handlers once a fd table exists to hand them out from.
 *
 * Semantics:
 * - `read` never blocks past what has already arrived; it drains the inbound ring buffer and
 *   returns a short read, exactly like `recv()` on a stream socket with no `MSG_WAITALL`.
 * - `read` returns 0 (EOF) once the socket has closed and the buffer is drained.
 * - `write` throws `ECONNRESET` once the socket has closed.
 * - `write` before the connection finishes opening buffers nothing -- the caller gets `EAGAIN`,
 *   matching a non-blocking `connect()` in progress; poll for `EPOLLOUT` (or await `opened`) first.
 * - Message framing is `WebSocket`'s own: each `message` event's payload becomes one push into the
 *   inbound buffer, so a reader on this end sees exactly the byte boundaries the sender wrote in
 *   (an ecmaOS socket is a message-stream hybrid, not a raw TCP byte stream -- documented here
 *   because there's no lower layer to enforce true TCP-style coalescing over a browser WebSocket).
 */

import { withErrno } from 'kerium'
import { EPOLLIN, EPOLLOUT, WaitQueue } from '@zenfs/linux'
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

export interface Socket {
  ops: FileOperations
  file: DeviceFile
  /** Resolves once the underlying WebSocket reaches OPEN, rejects if it errors before then. */
  opened: Promise<void>
  /** Closes the underlying WebSocket and releases the read queue. */
  close(): void
}

function socketFile(url: string): DeviceFile {
  return {
    path: `socket:[${url}]`,
    inode: { ino: 0, mode: 0, nlink: 1, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0, uid: 0, gid: 0 } as DeviceFile['inode'],
    devt: { major: 0, minor: 0 }
  }
}

/** Open a WebSocket and expose it as a `FileOperations` end. */
export function createSocket(url: string, protocols?: string | string[]): Socket {
  const buffer = new RingBuffer()
  const readQueue = new WaitQueue()
  let isOpen = false
  let isClosed = false

  const ws = new WebSocket(url, protocols)
  ws.binaryType = 'arraybuffer'

  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => { isOpen = true; resolve() }, { once: true })
    ws.addEventListener('error', () => reject(withErrno('ECONNREFUSED', `Failed to connect to ${url}`)), { once: true })
  })

  ws.addEventListener('message', (event) => {
    const data = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : new TextEncoder().encode(String(event.data))
    buffer.push(data)
    readQueue.wake_up()
  })

  ws.addEventListener('close', () => {
    isClosed = true
    readQueue.wake_up()
  })

  const ops: FileOperations = {
    read: (_file, into) => {
      const n = buffer.shift(into)
      return n
    },
    write: (_file, data) => {
      if (isClosed) throw withErrno('ECONNRESET')
      if (!isOpen) throw withErrno('EAGAIN', 'Connection is not open yet')
      ws.send(data as BufferSource)
      return data.byteLength
    },
    poll: () => {
      // A closed socket reads as EPOLLIN (matching lib/pipe.ts's EOF convention: a read on a
      // closed, drained end must return 0 rather than block, so readiness is reported either way).
      let events = 0
      if (buffer.size > 0 || isClosed) events |= EPOLLIN
      if (isOpen && !isClosed) events |= EPOLLOUT
      return events
    },
    poll_wait: () => readQueue,
    release: () => {
      isClosed = true
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
      readQueue.wake_up()
    }
  }

  return {
    ops,
    file: socketFile(url),
    opened,
    close: () => ops.release?.(socketFile(url))
  }
}
