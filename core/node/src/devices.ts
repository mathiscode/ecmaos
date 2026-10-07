import { constants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

import { DeviceError } from '@ecmaos/peer'
import type { DeviceSession, DeviceSource, Value } from '@ecmaos/peer'

/** A host device offered to the machines that log in */
export interface DeviceSpec {
  name: string
  kind: 'file' | 'loopback'
  /** For `file`: the path on the host */
  path?: string
  /** Whether the machine may read from the device, and write to it. Read-only unless the device was given `:rw` or `:wo`. */
  read: boolean
  write: boolean
}

const NamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

/** `NAME=file:/dev/ttyUSB0[:rw|:wo]`, `NAME=loopback`; read-only by default */
export function parseDevice(argument: string): DeviceSpec {
  let text = argument
  let read = true
  let write = false
  if (text.endsWith(':rw')) { write = true; text = text.slice(0, -3) } else if (text.endsWith(':wo')) { read = false; write = true; text = text.slice(0, -3) } else if (text.endsWith(':ro')) text = text.slice(0, -3)
  const equals = text.indexOf('=')
  if (equals <= 0) throw new Error(`device '${argument}' needs a name: NAME=file:PATH[:rw] or NAME=loopback`)
  const name = text.slice(0, equals)
  if (!NamePattern.test(name)) throw new Error(`device name '${name}' must start with a letter and may only hold letters, digits, dashes and underscores`)
  const kind = text.slice(equals + 1)
  if (kind === 'loopback') return { name, kind: 'loopback', read: true, write: true }
  if (kind.startsWith('file:')) {
    const target = kind.slice('file:'.length)
    if (!target) throw new Error(`device ${name} needs a path`)
    return { name, kind: 'file', path: path.resolve(target), read, write }
  }
  throw new Error(`device ${name}: unknown kind (use file:PATH or loopback)`)
}

/** A list of devices, one `NAME=SPEC` per line; blank lines and lines starting with `#` are ignored */
export function parseDeviceList(text: string): DeviceSpec[] {
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(parseDevice)
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * A file, FIFO or character device (a serial port) on the host. It is opened without blocking and polled, so a device with
 * nothing to say neither ties up a thread nor keeps the link from closing. Only one machine may have it open at a time.
 */
function fileSession(spec: DeviceSpec, release: () => void): () => Promise<DeviceSession> {
  return async () => {
    // A device that is only written to is appended to, as a log or a printer is
    const access = spec.read ? (spec.write ? constants.O_RDWR : constants.O_RDONLY) : constants.O_WRONLY | constants.O_APPEND
    const flags = access | constants.O_NOCTTY | constants.O_NONBLOCK
    let handle: FileHandle
    try { handle = await fs.open(spec.path!, flags) } catch (error) {
      release()
      throw new DeviceError((error as { code?: string }).code ?? "EIO", `cannot open ${spec.name} (${(error as { code?: string }).code ?? "error"})`)
    }
    const stats = await handle.stat()
    // A regular file ends; a FIFO or a terminal that returns nothing just has nothing yet
    const regular = stats.isFile()
    let closed = false
    const buffer = new Uint8Array(16 * 1024)

    return {
      info: { kind: 'file', read: spec.read, write: spec.write, regular },
      read: !spec.read ? undefined : async () => {
        let wait = 2
        while (!closed) {
          try {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, regular ? undefined : null)
            if (bytesRead > 0) return buffer.slice(0, bytesRead)
            if (regular) return undefined
          } catch (error) {
            if ((error as { code?: string }).code !== 'EAGAIN') throw error
          }
          await sleep(wait)
          wait = Math.min(wait * 2, 40)
        }
        return undefined
      },
      // A device offered read-only has no way to write at all: bytes a peer sends anyway end the channel
      write: !spec.write ? undefined : async data => {
        let done = 0
        let wait = 2
        while (done < data.length) {
          if (closed) throw new DeviceError('ENODEV')
          try {
            const { bytesWritten } = await handle.write(data, done, data.length - done, regular ? undefined : null)
            done += bytesWritten
            wait = 2
          } catch (error) {
            if ((error as { code?: string }).code !== 'EAGAIN') throw error
            await sleep(wait)
            wait = Math.min(wait * 2, 40)
          }
        }
      },
      close() {
        if (closed) return
        closed = true
        void handle.close().catch(() => {}).finally(release)
      }
    }
  }
}

/** Everything written comes back as a read, in order; a place to try a device channel without hardware */
function loopbackSession(): () => Promise<DeviceSession> {
  return async () => {
    const queue: Uint8Array[] = []
    let waiting: ((chunk: Uint8Array | undefined) => void) | undefined
    let closed = false
    return {
      info: { kind: 'loopback', read: true, write: true },
      read: () => new Promise(resolve => {
        const next = queue.shift()
        if (next) resolve(next)
        else if (closed) resolve(undefined)
        else waiting = resolve
      }),
      async write(data) {
        if (waiting) { const resolve = waiting; waiting = undefined; resolve(data) } else queue.push(data)
      },
      async control(op, args): Promise<Value> {
        if (op === 'ping') return 'pong'
        if (op === 'echo') return args
        throw new DeviceError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
      },
      close() { closed = true; waiting?.(undefined); waiting = undefined }
    }
  }
}

/** The host's end of a spec: a source that hands out sessions, one at a time for a real device */
export function openDevice(spec: DeviceSpec): DeviceSource {
  if (spec.kind === 'loopback') return { name: spec.name, open: loopbackSession() }
  let busy = false
  const open = fileSession(spec, () => { busy = false })
  return {
    name: spec.name,
    async open() {
      if (busy) throw new DeviceError('EBUSY', `${spec.name} is in use`)
      busy = true
      return await open()
    }
  }
}
