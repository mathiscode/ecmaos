/// <reference types="w3c-web-serial" />

/**
 * A Web Serial port as a device session: the shape `@ecmaos/peer`'s `serveDevice` serves over a device channel, so a port
 * plugged into the browser's machine can be used as `/dev/NAME` on another one. (Declared here instead of imported, so this
 * package needs nothing from the peer package; the two shapes fit.)
 */

type Plain = string | number | boolean | null | Uint8Array | Plain[] | { [key: string]: Plain }

export interface SerialDeviceSession {
  info: { kind: string, read: boolean, write: boolean, [key: string]: Plain }
  read(): Promise<Uint8Array | undefined>
  write(data: Uint8Array): Promise<void>
  control(op: string, args: Plain[]): Promise<Plain>
  emit?: (name: string, data: Plain) => void
  close(): Promise<void>
}

export interface SerialSessionOptions {
  /** Default 9600. A port's speed is set when it is opened; changing it means opening again. */
  baudRate?: number
  dataBits?: 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd'
  flowControl?: 'none' | 'hardware'
  bufferSize?: number
}

/** Raised for a refused control call; `code` is what the far side sees */
export class SerialError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'SerialError'
  }
}

const isFlag = (value: Plain | undefined): value is boolean | undefined => value === undefined || typeof value === 'boolean'

/**
 * Opens `port` and serves it. Reads come from the port's readable stream one chunk at a time, so a reader that stops
 * reading stops the port's stream (and the device behind it holds back or drops, as serial hardware does). Controls:
 * `signals` (the input lines `dsr`, `cts`, `dcd`, `ri`), `set-signals` (`dtr`, `rts`, `brk`) and `port-info` (USB ids).
 */
export async function openSerialSession(port: SerialPort, options: SerialSessionOptions = {}): Promise<SerialDeviceSession> {
  const baudRate = options.baudRate ?? 9600
  if (!Number.isInteger(baudRate) || baudRate < 50 || baudRate > 4_000_000) throw new SerialError('EINVAL', 'bad baud rate')
  await port.open({ ...options, baudRate })
  const reader = port.readable!.getReader()
  const writer = port.writable!.getWriter()
  const usb = port.getInfo()
  let closed = false

  const session: SerialDeviceSession = {
    info: { kind: 'serial', read: true, write: true, baudRate, ...(usb.usbVendorId !== undefined ? { usbVendorId: usb.usbVendorId } : {}), ...(usb.usbProductId !== undefined ? { usbProductId: usb.usbProductId } : {}) },
    async read() {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return undefined
        if (value && value.length) return value
      }
    },
    async write(data) { await writer.write(data) },
    async control(op, args) {
      switch (op) {
        case 'signals': {
          const { dataSetReady, clearToSend, dataCarrierDetect, ringIndicator } = await port.getSignals()
          return { dsr: dataSetReady, cts: clearToSend, dcd: dataCarrierDetect, ri: ringIndicator }
        }
        case 'set-signals': {
          const wanted = args[0]
          if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted) || wanted instanceof Uint8Array) throw new SerialError('EINVAL', 'give {dtr, rts, brk}')
          const { dtr, rts, brk } = wanted as { [key: string]: Plain }
          if (!isFlag(dtr) || !isFlag(rts) || !isFlag(brk)) throw new SerialError('EINVAL', 'dtr, rts and brk are true or false')
          await port.setSignals({ ...(dtr !== undefined ? { dataTerminalReady: dtr } : {}), ...(rts !== undefined ? { requestToSend: rts } : {}), ...(brk !== undefined ? { break: brk } : {}) })
          return null
        }
        case 'port-info': return { ...port.getInfo() } as { [key: string]: Plain }
        default: throw new SerialError('ENOSYS', `no such operation: ${op.slice(0, 32)}`)
      }
    },
    async close() {
      if (closed) return
      closed = true
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      await writer.close().catch(() => {})
      await port.close().catch(() => {})
    }
  }

  const onDisconnect = (event: Event) => {
    if (event.target === port) session.emit?.('disconnect', null)
  }
  navigator.serial.addEventListener('disconnect', onDisconnect)
  const close = session.close
  session.close = async () => {
    navigator.serial.removeEventListener('disconnect', onDisconnect)
    await close()
  }
  return session
}
