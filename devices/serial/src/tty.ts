/// <reference types="w3c-web-serial" />

/**
 * Serial ports as Linux names them: `ttyACM<n>` for a board that speaks CDC ACM (major 166), `ttyUSB<n>` for a USB-serial
 * bridge chip (major 188), `rfcomm<n>` for a Bluetooth serial port (major 216). Each is a terminal: the port is the
 * hardware behind a `@zenfs/linux` tty, so it has the tty's line discipline (canonical and echoing until a program sets it
 * raw, as on Linux) and answers `TCGETS` / `TCSETS` with a `c_cflag` that drives the port.
 *
 * Web Serial fixes speed, character size, stop bits, parity and flow control when a port is opened, so a change to any of
 * them closes and opens the port again; what was read before stays read. A setting the browser cannot do (5 or 6 bit
 * characters, mark or space parity, a speed given as `BOTHER`) is left as it was, and `TCGETS` shows what is in effect, as a
 * Linux driver does with what its hardware lacks.
 *
 * A line is made when its port is there (at boot, when granted, when plugged in) and the lowest free number is taken, as on
 * Linux; `/dev/serial/by-id` has a name that stays with the device. Unplugging hangs the line up: its node goes, and a
 * program that still has it open reads the end of the file and gets `EIO` from a write until it closes it.
 */

import { Signal, TTYDriver, default_termios } from '@zenfs/linux'
import type { TTY } from '@zenfs/linux'
import { fs } from '@zenfs/core'
import { withErrno } from 'kerium'
import type { KernelContext } from '@ecmaos/types'

import { openSerialSession } from './session.js'
import type { SerialDeviceSession, SerialSessionOptions } from './session.js'

// `c_cflag`, from `<asm-generic/termbits.h>`
export const CBAUD = 0o10017
export const CBAUDEX = 0o10000
export const CSIZE = 0o60
export const CS7 = 0o40
export const CS8 = 0o60
export const CSTOPB = 0o100
export const CREAD = 0o200
export const PARENB = 0o400
export const PARODD = 0o1000
export const HUPCL = 0o2000
export const CLOCAL = 0o4000
export const CMSPAR = 0o10000000000
export const CRTSCTS = 0o20000000000
export const B0 = 0
export const B9600 = 0o15

/** The speed of each `B*` constant: the index is the value without `CBAUDEX`, the second list the ones with it */
const Speeds = [0, 50, 75, 110, 134, 150, 200, 300, 600, 1200, 1800, 2400, 4800, 9600, 19200, 38400]
const SpeedsEx = [undefined, 57600, 115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1152000, 1500000, 2000000, 2500000, 3000000, 3500000, 4000000]

/** The speed `c_cflag` asks for, `0` for `B0` (hang up), `undefined` for one the browser cannot set (`BOTHER`) */
export function speedOf(cflag: number): number | undefined {
  const bits = cflag & CBAUD
  return bits & CBAUDEX ? SpeedsEx[bits & ~CBAUDEX] : Speeds[bits]
}

// ioctls, from `<asm-generic/ioctls.h>`
export const TCSBRK = 0x5409
export const TIOCMGET = 0x5415
export const TIOCMBIS = 0x5416
export const TIOCMBIC = 0x5417
export const TIOCMSET = 0x5418
export const TCSBRKP = 0x5425
export const TIOCSBRK = 0x5427
export const TIOCCBRK = 0x5428

// modem lines, `TIOCM_*`
export const TIOCM_DTR = 0x002
export const TIOCM_RTS = 0x004
export const TIOCM_CTS = 0x020
export const TIOCM_CAR = 0x040
export const TIOCM_RNG = 0x080
export const TIOCM_DSR = 0x100

/** What Linux's `cdc-acm` and `usb-serial` start a port with */
const InitialCflag = B9600 | CS8 | CREAD | HUPCL | CLOCAL

/** Bytes waiting in a line for a reader before the port is no longer read from, as a tty throttles its hardware */
const ReadLimit = 64 * 1024
/** How often the input lines are looked at once a program has asked for them (`TIOCMGET`); the browser has no event */
const SignalsInterval = 100

/** USB-serial bridge chips, by vendor id, with the name Linux's driver gives them; any other USB device is CDC ACM */
const Bridges: Readonly<Record<number, string>> = {
  0x0403: 'FTDI USB Serial Device',
  0x10c4: 'cp210x',
  0x1a86: 'ch341-uart',
  0x067b: 'pl2303'
}

interface Line {
  port: SerialPort
  tty: TTY
  /** The name under `/dev/serial/by-id`, for a USB port */
  byId?: string
  session?: SerialDeviceSession
  /** What the session was opened with */
  options?: SerialSessionOptions
  /** The last speed that was not `B0`, which the port goes back to */
  speed: number
  /** Opens, writes and changes, one after another, in the order they were asked for */
  queue: Promise<void>
  /** The output lines, which are set and not read back */
  dtr: boolean
  rts: boolean
  /** The input lines, as last looked at */
  inputs: number
  signalsTimer?: ReturnType<typeof setInterval>
  /** Resolved when a reader has taken the line below {@link ReadLimit} */
  drained?: () => void
  /** The kernel has told the line `open` and not yet `close`: a program has it open */
  opened: boolean
  /** The port was unplugged */
  hungUp: boolean
  /** Why the port could not be opened or failed, until the line is closed */
  failure?: Error
}

const lines = new Map<TTY, Line>()
let log: KernelContext['log'] | undefined

const lineOf = (tty: TTY) => {
  const line = lines.get(tty)
  if (!line) throw withErrno('ENXIO')
  return line
}

const enqueue = (line: Line, step: () => Promise<void> | void) => {
  line.queue = line.queue.then(step).catch(error => fail(line, error as Error))
}

function fail(line: Line, error: Error) {
  log?.warn(`serial: ${line.tty.name}: ${error.message}`)
  line.failure = error
  line.tty.wake_read()
}

function optionsOf(cflag: number, speed: number): SerialSessionOptions {
  return {
    baudRate: speed,
    dataBits: (cflag & CSIZE) === CS7 ? 7 : 8,
    stopBits: cflag & CSTOPB ? 2 : 1,
    parity: cflag & PARENB ? (cflag & PARODD ? 'odd' : 'even') : 'none',
    flowControl: (cflag >>> 0) & CRTSCTS ? 'hardware' : 'none'
  }
}

const sameOptions = (a: SerialSessionOptions | undefined, b: SerialSessionOptions) =>
  !!a && a.baudRate === b.baudRate && a.dataBits === b.dataBits && a.stopBits === b.stopBits && a.parity === b.parity && a.flowControl === b.flowControl

/** `cflag` with what the browser cannot do put back as it was in `old` */
export function supportedCflag(cflag: number, old: number): number {
  let speed = cflag & CBAUD
  if (speedOf(speed) === undefined) speed = old & CBAUD
  let size = cflag & CSIZE
  if (size !== CS7 && size !== CS8) size = old & CSIZE
  return ((cflag & ~(CBAUD | CSIZE | CMSPAR)) | speed | size) >>> 0
}

const cflagOf = (tty: TTY) => ((tty.termios as { cflag?: number }).cflag ?? InitialCflag) >>> 0

async function setLines(line: Line, signals: { dtr?: boolean, rts?: boolean, brk?: boolean }) {
  if (signals.dtr !== undefined) line.dtr = signals.dtr
  if (signals.rts !== undefined) line.rts = signals.rts
  await line.session?.control('set-signals', [signals])
}

/** Reads the port into the line until the session ends; a session replaced by a change of settings ends quietly */
async function pump(line: Line, session: SerialDeviceSession) {
  try {
    for (;;) {
      if (line.tty.available >= ReadLimit) await new Promise<void>(resolve => { line.drained = resolve })
      const chunk = await session.read()
      if (line.session !== session) return
      if (!chunk) break
      line.tty.receive(chunk)
    }
    // The port's stream ended while the line had it open: the device went away
    if (line.session === session) hangUp(line)
  } catch (error) {
    if (line.session === session) { fail(line, error as Error); hangUp(line) }
  }
}

async function open(line: Line) {
  const cflag = cflagOf(line.tty)
  const options = optionsOf(cflag, line.speed)
  const session = await openSerialSession(line.port, options)
  line.session = session
  line.options = options
  // A port's DTR and RTS go up when it is opened, unless the speed is B0
  const up = speedOf(cflag) !== B0
  await setLines(line, { dtr: up, rts: up })
  void pump(line, session)
}

async function close(line: Line) {
  const session = line.session
  line.session = undefined
  line.options = undefined
  line.drained?.()
  if (!session) return
  if (cflagOf(line.tty) & HUPCL) await session.control('set-signals', [{ dtr: false, rts: false }]).catch(() => {})
  await session.close()
}

function stopSignals(line: Line) {
  clearInterval(line.signalsTimer)
  line.signalsTimer = undefined
}

async function readSignals(line: Line) {
  const answer = await line.session?.control('signals', []) as { dsr?: boolean, cts?: boolean, dcd?: boolean, ri?: boolean } | undefined
  if (!answer) return
  line.inputs = (answer.dsr ? TIOCM_DSR : 0) | (answer.cts ? TIOCM_CTS : 0) | (answer.dcd ? TIOCM_CAR : 0) | (answer.ri ? TIOCM_RNG : 0)
}

function modemBits(line: Line): number {
  if (!line.signalsTimer && line.session) {
    void readSignals(line).catch(() => {})
    line.signalsTimer = setInterval(() => { void readSignals(line).catch(() => {}) }, SignalsInterval)
    ;(line.signalsTimer as { unref?: () => void }).unref?.()
  }
  return (line.dtr ? TIOCM_DTR : 0) | (line.rts ? TIOCM_RTS : 0) | line.inputs
}

const setModem = (line: Line, bits: number) => enqueue(line, () => setLines(line, { dtr: !!(bits & TIOCM_DTR), rts: !!(bits & TIOCM_RTS) }))

/** A break of `ms` milliseconds, after what was written before it */
const sendBreak = (line: Line, ms: number) => enqueue(line, async () => {
  await setLines(line, { brk: true })
  await new Promise(resolve => setTimeout(resolve, ms))
  await setLines(line, { brk: false })
})

const pointer = (value: unknown) => typeof value === 'number' ? value : 0

/** One driver per kind of port; they share the operations, which find the port from the tty */
class SerialDriver extends TTYDriver {
  constructor(name: string, major: number, subtype: string) {
    super({
      name,
      major,
      lines: 256,
      type: 'serial',
      subtype,
      init_termios: { ...default_termios, cflag: InitialCflag } as never,
      ops: {
        write(tty, data) {
          const line = lineOf(tty)
          if (line.hungUp || line.failure) throw withErrno('EIO', line.failure?.message ?? 'the device is gone')
          // the line discipline hands over the caller's own buffer when there is no output processing
          const bytes = data.slice()
          enqueue(line, async () => { await line.session?.write(bytes) })
        },
        open(tty) {
          const line = lineOf(tty)
          line.opened = true
          if (line.hungUp) return
          line.failure = undefined
          enqueue(line, () => open(line))
        },
        close(tty) {
          const line = lineOf(tty)
          line.opened = false
          stopSignals(line)
          tty.ldisc.flush()
          enqueue(line, () => close(line))
          line.queue = line.queue.then(() => {
            line.failure = undefined
            if (line.hungUp) forget(line)
          })
        },
        set_termios(tty, old) {
          const line = lineOf(tty)
          const before = ((old as { cflag?: number }).cflag ?? InitialCflag) >>> 0
          const cflag = supportedCflag(cflagOf(tty), before)
          ;(tty.termios as { cflag?: number }).cflag = cflag
          const speed = speedOf(cflag)!
          if (speed !== B0) line.speed = speed
          // a line nobody has open is opened with its settings
          if (!line.opened) return
          enqueue(line, async () => {
            if (!line.session) return
            if (speed === B0) { if (speedOf(before) !== B0) await setLines(line, { dtr: false, rts: false }); return }
            const options = optionsOf(cflag, speed)
            if (!sameOptions(line.options, options)) {
              const session = line.session
              line.session = undefined
              await session.close()
              await open(line)
            } else if (speedOf(before) === B0) await setLines(line, { dtr: true, rts: true })
          })
        },
        ioctl: {
          [TIOCMGET]: (_$, tty) => modemBits(lineOf(tty)),
          [TIOCMSET]: (_$, tty, bits) => setModem(lineOf(tty), pointer(bits)),
          [TIOCMBIS]: (_$, tty, bits) => { const line = lineOf(tty); setModem(line, modemBits(line) | pointer(bits)) },
          [TIOCMBIC]: (_$, tty, bits) => { const line = lineOf(tty); setModem(line, modemBits(line) & ~pointer(bits)) },
          // 0 is a break; anything else is `tcdrain`, which writes already are, as they go out in order
          [TCSBRK]: (_$, tty, arg) => { if (!pointer(arg)) sendBreak(lineOf(tty), 250) },
          [TCSBRKP]: (_$, tty, arg) => sendBreak(lineOf(tty), pointer(arg) ? Math.min(pointer(arg), 100) * 100 : 250),
          [TIOCSBRK]: (_$, tty) => { const line = lineOf(tty); enqueue(line, () => setLines(line, { brk: true })) },
          [TIOCCBRK]: (_$, tty) => { const line = lineOf(tty); enqueue(line, () => setLines(line, { brk: false })) }
        }
      }
    })

    const { read, poll } = this.fops
    // A hung-up line reads as the end of the file for as long as it is held; a failed one gives the error once
    this.fops.read = (file, buffer, start, end) => {
      const line = lineOf(this.tty_of(file))
      if (line.hungUp && !line.tty.available) return 0
      if (line.failure && !line.tty.available) throw withErrno('EIO', line.failure.message)
      const count = read!(file, buffer, start, end)
      if (line.drained && line.tty.available < ReadLimit / 2) { const drained = line.drained; line.drained = undefined; drained() }
      return count
    }
    this.fops.poll = file => {
      const line = lineOf(this.tty_of(file))
      return line.hungUp || line.failure ? 1 | 4 /* EPOLLIN | EPOLLOUT */ : poll!(file)
    }
  }
}

export const acmDriver = new SerialDriver('ttyACM', 166, 'acm')
export const usbSerialDriver = new SerialDriver('ttyUSB', 188, 'usb-serial')
export const rfcommDriver = new SerialDriver('rfcomm', 216, 'rfcomm')

const hex = (value: number) => value.toString(16).padStart(4, '0')

function driverOf(port: SerialPort): { driver: SerialDriver, kind: string } {
  const { usbVendorId } = port.getInfo()
  if (usbVendorId === undefined) return { driver: rfcommDriver, kind: 'rfcomm' }
  const bridge = Bridges[usbVendorId]
  return bridge ? { driver: usbSerialDriver, kind: bridge } : { driver: acmDriver, kind: 'cdc_acm' }
}

/** The line a port has, if it has one */
export function lineName(port: SerialPort): string | undefined {
  for (const line of lines.values()) if (line.port === port && !line.hungUp) return line.tty.name
  return undefined
}

async function linkById(line: Line, others: Line[]) {
  const { usbVendorId, usbProductId } = line.port.getInfo()
  if (usbVendorId === undefined) return
  const base = `usb-${hex(usbVendorId)}_${hex(usbProductId ?? 0)}`
  // Two devices with the same ids are told apart by a number, the first having none
  const taken = new Set(others.map(other => other.byId))
  let name = `${base}-if00`
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}-if00`
  line.byId = name
  await fs.promises.mkdir('/dev/serial/by-id', { recursive: true })
  await fs.promises.symlink(`../../${line.tty.name}`, `/dev/serial/by-id/${name}`)
}

/** Gives `port` a line (`/dev/ttyACM0` ...), unless it has one; returns the line's name */
export function attachPort(port: SerialPort): string {
  const known = lineName(port)
  if (known) return known
  const { driver, kind } = driverOf(port)
  let index = 0
  while (driver.ttys.has(index)) index++
  const tty = driver.line(index)
  const line: Line = { port, tty, speed: 9600, queue: Promise.resolve(), dtr: false, rts: false, inputs: 0, opened: false, hungUp: false }
  const others = [...lines.values()]
  lines.set(tty, line)
  tty.register()
  void linkById(line, others).catch(() => { /* the name in /dev is enough */ })
  const { usbVendorId, usbProductId } = port.getInfo()
  const ids = usbVendorId === undefined ? '' : ` (${hex(usbVendorId)}:${hex(usbProductId ?? 0)})`
  if (kind === 'cdc_acm') log?.info(`cdc_acm: ${tty.name}: USB ACM device${ids}`)
  else if (kind === 'rfcomm') log?.info(`rfcomm: ${tty.name}: Bluetooth serial port`)
  else log?.info(`usbserial: ${kind} converter now attached to ${tty.name}${ids}`)
  return tty.name
}

function forget(line: Line) {
  lines.delete(line.tty)
  line.tty.driver.ttys.delete(line.tty.index)
}

function hangUp(line: Line) {
  if (line.hungUp) return
  line.hungUp = true
  stopSignals(line)
  const session = line.session
  line.session = undefined
  void Promise.resolve(session?.close()).catch(() => {})
  line.drained?.()
  try { line.tty.unregister() } catch { /* already gone */ }
  if (line.byId) void fs.promises.unlink(`/dev/serial/by-id/${line.byId}`).catch(() => {})
  log?.info(`serial: ${line.tty.name}: disconnected`)
  // whatever the line is the controlling terminal of is told, as `tty_hangup` does
  line.tty.signal(Signal.HUP)
  line.tty.wake_read()
  // A line nobody has open goes at once; one that is held goes with its last close
  if (!line.opened) forget(line)
}

/** Hangs up the line of `port`, which has been unplugged or forgotten */
export function detachPort(port: SerialPort): void {
  for (const line of [...lines.values()]) if (line.port === port) hangUp(line)
}

/** The drivers, with a line for each port the browser has already granted; told to the kernel once per realm */
export async function serialTerminals(ctx: KernelContext): Promise<TTYDriver[]> {
  log = ctx.log
  const drivers = [acmDriver, usbSerialDriver, rfcommDriver]
  if (typeof navigator === 'undefined' || !navigator.serial) return drivers
  for (const port of await navigator.serial.getPorts()) attachPort(port)
  return drivers
}
