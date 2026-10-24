/**
 * Shows or changes the terminal's line settings: `stty -a`, `stty size`, `stty -echo`, `stty sane`. These are the
 * line discipline's termios flags. The kernel restores the terminal's settings when the program that changed them
 * ends, so a change lasts only for a command started under it.
 *
 * `-F DEVICE` acts on another terminal, a serial port above all: `stty -F /dev/ttyACM0 115200 raw`. A port also has its
 * control settings (`c_cflag`): the speed, `cs7` / `cs8`, `parenb`, `parodd`, `cstopb`, `crtscts`, `clocal`, `hupcl`.
 * A port keeps them until they are changed again.
 */

import { isTty, ttyFd, terminalSize } from './lib/tty.mjs'

const { argv, exit, writeAll, tcgetattr, tcsetattr, open, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`stty: ${text}\n`))

const usage = `Usage: stty [-F DEVICE] [-a | size | SETTING...]
Print or change terminal line settings.

  -F, --file=DEVICE  act on DEVICE (a serial port: /dev/ttyACM0) instead of standard input
  -a, --all          print all the settings
  size               print the number of rows and columns
  SETTING            [-]echo, [-]icanon, [-]isig, [-]icrnl, [-]onlcr, [-]opost, [-]echoe, [-]echok, [-]ixon,
                     raw (the same as -icanon -echo -isig -icrnl -opost), cooked or sane;
                     for a serial port also SPEED (9600, 115200, ...), cs7, cs8, [-]parenb, [-]parodd,
                     [-]cstopb, [-]crtscts, [-]clocal, [-]hupcl
  --help             display this help and exit`

// Linux termios bits (`<asm-generic/termbits.h>`)
const L = { isig: 0o1, icanon: 0o2, echo: 0o10, echoe: 0o20, echok: 0o40, echonl: 0o100, noflsh: 0o200, tostop: 0o400, iexten: 0o100000 }
const I = { ignbrk: 0o1, brkint: 0o2, ignpar: 0o4, parmrk: 0o10, inpck: 0o20, istrip: 0o40, inlcr: 0o100, igncr: 0o200, icrnl: 0o400, ixon: 0o2000, ixoff: 0o10000 }
const O = { opost: 0o1, onlcr: 0o4 }
const C = { cstopb: 0o100, cread: 0o200, parenb: 0o400, parodd: 0o1000, hupcl: 0o2000, clocal: 0o4000, crtscts: 0o20000000000 }
const GROUPS = { lflag: L, iflag: I, oflag: O, cflag: C }
const CBAUD = 0o10017, CBAUDEX = 0o10000, CSIZE = 0o60, SIZES = { cs5: 0, cs6: 0o20, cs7: 0o40, cs8: 0o60 }
/** The speed of each `B*` value: the index is the value without `CBAUDEX`, the second list the ones with it */
const SPEEDS = [0, 50, 75, 110, 134, 150, 200, 300, 600, 1200, 1800, 2400, 4800, 9600, 19200, 38400]
const SPEEDS_EX = [undefined, 57600, 115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1152000, 1500000, 2000000, 2500000, 3000000, 3500000, 4000000]
const speedOf = cflag => (cflag & CBAUDEX ? SPEEDS_EX[cflag & CBAUD & ~CBAUDEX] : SPEEDS[cflag & CBAUD])
const speedBits = speed => {
  const plain = SPEEDS.indexOf(speed)
  if (plain >= 0) return plain
  const extended = SPEEDS_EX.indexOf(speed)
  return extended > 0 ? CBAUDEX | extended : undefined
}
const where = name => Object.entries(GROUPS).find(([, bits]) => name in bits)

function terminal(device) {
  // O_RDONLY | O_NOCTTY | O_NONBLOCK, as GNU stty opens one: a port must not become the controlling terminal
  if (device !== undefined) return open(device, O_RDONLY | 0o400 | 0o4000, 0)
  const fd = ttyFd()
  if (fd >= 0) return fd
  try { return open('/dev/tty', O_RDONLY, 0) } catch { return -1 }
}

function main() {
  const args = argv.slice(1)
  if (args[0] === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
  let device
  const at = args.findIndex(arg => arg === '-F' || arg === '--file' || arg.startsWith('--file='))
  if (at >= 0) {
    device = args[at].startsWith('--file=') ? args[at].slice('--file='.length) : args[at + 1]
    if (!device) { err(`option requires an argument -- 'F'`); return 1 }
    args.splice(at, args[at].startsWith('--file=') ? 1 : 2)
  }
  let fd
  try { fd = terminal(device) } catch (error) { err(`${device}: ${error?.message ?? error}`); return 1 }
  if (fd < 0 || !isTty(fd)) { err(`${device ?? 'standard input'}: Inappropriate ioctl for device`); return 1 }

  if (args[0] === 'size') {
    const { rows, cols } = terminalSize(fd)
    writeAll(1, encoder.encode(`${rows} ${cols}\n`))
    return 0
  }

  if (args.length === 0 || args[0] === '-a' || args[0] === '--all') {
    const t = tcgetattr(fd)
    const { rows, cols } = terminalSize(fd)
    const flags = (group, bits) => Object.entries(bits).map(([name, bit]) => ((t[group] >>> 0) & bit ? '' : '-') + name)
    // a pty has no speed of its own, and shows the one Linux's do
    const cflag = t.cflag >>> 0
    const lines = []
    if (args.length) lines.push(`speed ${speedOf(cflag) || 38400} baud; rows ${rows}; columns ${cols}; line = 0;`)
    else if (device !== undefined) lines.push(`speed ${speedOf(cflag)} baud; line = 0;`)
    if (cflag) {
      const size = Object.entries(SIZES).find(([, bits]) => (cflag & CSIZE) === bits)[0]
      lines.push([...flags('cflag', C), size].join(' ') + ';')
    }
    lines.push(flags('iflag', I).join(' ') + ';', flags('oflag', O).join(' ') + ';', flags('lflag', L).join(' ') + ';')
    writeAll(1, encoder.encode(lines.join('\n') + '\n'))
    return 0
  }

  const t = tcgetattr(fd)
  const next = { lflag: t.lflag, iflag: t.iflag, oflag: t.oflag, cflag: t.cflag >>> 0 }
  const set = (name, on) => {
    const found = where(name)
    if (!found) throw new Error(`invalid argument '${on ? '' : '-'}${name}'`)
    const [group, bits] = found
    next[group] = (on ? next[group] | bits[name] : next[group] & ~bits[name]) >>> 0
  }
  for (const arg of args) {
    if (/^\d+$/.test(arg)) {
      const bits = speedBits(Number(arg))
      if (bits === undefined) throw new Error(`invalid argument '${arg}'`)
      next.cflag = (next.cflag & ~CBAUD) | bits
    }
    else if (arg in SIZES) next.cflag = (next.cflag & ~CSIZE) | SIZES[arg]
    else if (arg === 'raw') { for (const name of ['icanon', 'echo', 'isig', 'icrnl', 'opost']) set(name, false) }
    else if (arg === '-raw' || arg === 'cooked') { for (const name of ['icanon', 'echo', 'isig', 'icrnl', 'opost']) set(name, true) }
    else if (arg === 'sane') {
      for (const name of ['icanon', 'echo', 'isig', 'echoe', 'echok', 'iexten', 'icrnl', 'ixon', 'opost', 'onlcr', 'brkint']) set(name, true)
      for (const name of ['echonl', 'igncr', 'inlcr', 'istrip', 'ignbrk', 'tostop']) set(name, false)
    }
    else if (arg.startsWith('-')) set(arg.slice(1), false)
    else set(arg, true)
  }
  tcsetattr(fd, next)
  // what the port could not do is left as it was; say so, as GNU stty does when a setting did not take
  if (device !== undefined && (tcgetattr(fd).cflag >>> 0) !== next.cflag) { err(`${device}: unable to perform all requested operations`); return 1 }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
