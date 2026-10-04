/**
 * Show or change the terminal's line settings: `stty -a`, `stty size`, `stty -echo`, `stty sane`.
 *
 * These are the real termios flags of the terminal's line discipline, so `stty -echo` stops the terminal
 * echoing what is typed until it is changed back, and `stty -isig` stops `^C` raising a signal. The settings
 * of the terminal are put back when the program that changed them ends (the kernel does that), so what
 * `stty` sets lasts for the command that follows it only if one is started under it; at the prompt a change
 * is undone as soon as `stty` exits, which is what this system does with every program's terminal changes.
 */

import { isTty, ttyFd, terminalSize } from './lib/tty.mjs'

const { argv, exit, writeAll, tcgetattr, tcsetattr, open, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`stty: ${text}\n`))

const usage = `Usage: stty [-a | size | SETTING...]
Print or change terminal line settings.

  -a, --all   print all the settings
  size        print the number of rows and columns
  SETTING     [-]echo, [-]icanon, [-]isig, [-]icrnl, [-]onlcr, [-]opost, [-]echoe, [-]echok, [-]ixon,
              raw (the same as -icanon -echo -isig -icrnl -opost), cooked or sane
  --help      display this help and exit`

// Linux termios bits (`<asm-generic/termbits.h>`)
const L = { isig: 0o1, icanon: 0o2, echo: 0o10, echoe: 0o20, echok: 0o40, echonl: 0o100, noflsh: 0o200, tostop: 0o400, iexten: 0o100000 }
const I = { ignbrk: 0o1, brkint: 0o2, ignpar: 0o4, parmrk: 0o10, inpck: 0o20, istrip: 0o40, inlcr: 0o100, igncr: 0o200, icrnl: 0o400, ixon: 0o2000, ixoff: 0o10000 }
const O = { opost: 0o1, onlcr: 0o4 }
const GROUPS = { lflag: L, iflag: I, oflag: O }
const where = name => Object.entries(GROUPS).find(([, bits]) => name in bits)

function terminal() {
  const fd = ttyFd()
  if (fd >= 0) return fd
  try { return open('/dev/tty', O_RDONLY, 0) } catch { return -1 }
}

function main() {
  const args = argv.slice(1)
  if (args[0] === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
  const fd = terminal()
  if (fd < 0 || !isTty(fd)) { err('standard input: Inappropriate ioctl for device'); return 1 }

  if (args[0] === 'size') {
    const { rows, cols } = terminalSize(fd)
    writeAll(1, encoder.encode(`${rows} ${cols}\n`))
    return 0
  }

  if (args.length === 0 || args[0] === '-a' || args[0] === '--all') {
    const t = tcgetattr(fd)
    const { rows, cols } = terminalSize(fd)
    const flags = bits => Object.entries(bits).map(([name, bit]) => (t[bits === L ? 'lflag' : bits === I ? 'iflag' : 'oflag'] & bit ? '' : '-') + name)
    const lines = []
    if (args.length) lines.push(`speed 38400 baud; rows ${rows}; columns ${cols}; line = 0;`)
    lines.push(flags(I).join(' ') + ';', flags(O).join(' ') + ';', flags(L).join(' ') + ';')
    writeAll(1, encoder.encode(lines.join('\n') + '\n'))
    return 0
  }

  const t = tcgetattr(fd)
  const next = { lflag: t.lflag, iflag: t.iflag, oflag: t.oflag }
  const set = (name, on) => {
    const found = where(name)
    if (!found) throw new Error(`invalid argument '${on ? '' : '-'}${name}'`)
    const [group, bits] = found
    next[group] = on ? next[group] | bits[name] : next[group] & ~bits[name]
  }
  for (const arg of args) {
    if (arg === 'raw') { for (const name of ['icanon', 'echo', 'isig', 'icrnl', 'opost']) set(name, false) }
    else if (arg === '-raw' || arg === 'cooked') { for (const name of ['icanon', 'echo', 'isig', 'icrnl', 'opost']) set(name, true) }
    else if (arg === 'sane') {
      for (const name of ['icanon', 'echo', 'isig', 'echoe', 'echok', 'iexten', 'icrnl', 'ixon', 'opost', 'onlcr', 'brkint']) set(name, true)
      for (const name of ['echonl', 'igncr', 'inlcr', 'istrip', 'ignbrk', 'tostop']) set(name, false)
    }
    else if (arg.startsWith('-')) set(arg.slice(1), false)
    else set(arg, true)
  }
  tcsetattr(fd, next)
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
