/**
 * A `WebSocket`-backed socket end with `FileOperations`, in the shape of `lib/pipe.ts`. Only its unit tests use it;
 * `socket()` is loopback-only and external connections go through `kernel.sockets`.
 * - `read` returns what has arrived (a short read), and 0 (EOF) once the socket is closed and the buffer is drained.
 * - `write` throws `ECONNRESET` once closed, and `EAGAIN` before the connection opens.
 * - Framing is `WebSocket`'s: each message is one push, so a reader sees the sender's boundaries.
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
