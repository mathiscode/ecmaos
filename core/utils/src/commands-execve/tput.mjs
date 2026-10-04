/**
 * Ask the terminal for a capability: `tput cols`, `tput bold`, `tput setaf 1`, `tput cup 5 10`.
 *
 * ecmaOS terminals are xterm-compatible, so the capabilities are the ANSI sequences xterm uses, and `cols`,
 * `lines` come from the terminal's real size. `-T TYPE` is accepted and ignored.
 */

import { isTty, ttyFd, terminalSize } from './lib/tty.mjs'

const { argv, exit, writeAll, env } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`tput: ${text}\n`))
const ESC = '\x1b'

const usage = `Usage: tput [-T TYPE] CAPABILITY [ARGUMENT]...
Print the value of a terminal capability.

  cols, lines, colors            the size and the number of colors
  clear, home, el, ed            clear the screen, home the cursor, clear to end of line / screen
  cup ROW COL                    move the cursor (0-based)
  cuu1, cud1, cuf1, cub1         move the cursor one place up, down, forward, back
  cuu N, cud N, cuf N, cub N     move it N places
  bold, dim, smul, rmul, rev, sgr0   text attributes, and sgr0 clears them
  setaf N, setab N               foreground and background color (0-255)
  civis, cnorm                   hide and show the cursor
  smcup, rmcup                   switch to and from the alternate screen
  bel, cr, nl, sc, rc            bell, carriage return, newline, save and restore the cursor
  longname                       a description of the terminal

An unknown capability is an error. The status is 0, or 1 for an unknown capability.`

const color = (n, base) => {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined
  if (n < 8) return `${ESC}[${base + n}m`
  if (n < 16) return `${ESC}[${base + 60 + (n - 8)}m`
  return `${ESC}[${base + 8};5;${n}m`
}

const fixed = {
  clear: `${ESC}[H${ESC}[2J`, home: `${ESC}[H`, el: `${ESC}[K`, ed: `${ESC}[J`, el1: `${ESC}[1K`,
  cuu1: `${ESC}[A`, cud1: '\n', cuf1: `${ESC}[C`, cub1: '\b',
  bold: `${ESC}[1m`, dim: `${ESC}[2m`, smul: `${ESC}[4m`, rmul: `${ESC}[24m`, rev: `${ESC}[7m`, smso: `${ESC}[7m`, rmso: `${ESC}[27m`, sgr0: `${ESC}[0m`, blink: `${ESC}[5m`,
  civis: `${ESC}[?25l`, cnorm: `${ESC}[?25h`, cvvis: `${ESC}[?25h`,
  smcup: `${ESC}[?1049h`, rmcup: `${ESC}[?1049l`,
  bel: '\x07', cr: '\r', nl: '\n', sc: `${ESC}7`, rc: `${ESC}8`,
}

function main() {
  let args = argv.slice(1)
  if (args[0] === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
  if (args[0] === '-T') args = args.slice(2)
  else if (args[0]?.startsWith('-T')) args = args.slice(1)
  const [name, ...rest] = args
  if (!name) { err('usage: tput [-T TYPE] capability [argument]...'); return 1 }

  const fd = ttyFd()
  const size = fd >= 0 && isTty(fd) ? terminalSize(fd) : { rows: Number(env.LINES) || 24, cols: Number(env.COLUMNS) || 80 }
  const number = index => Number(rest[index])
  let out
  if (name === 'cols') out = `${size.cols}\n`
  else if (name === 'lines') out = `${size.rows}\n`
  else if (name === 'colors') out = '256\n'
  else if (name === 'longname') out = 'xterm-compatible terminal\n'
  else if (name === 'cup') {
    if (!Number.isInteger(number(0)) || !Number.isInteger(number(1))) { err('cup needs a row and a column'); return 1 }
    out = `${ESC}[${number(0) + 1};${number(1) + 1}H`
  }
  else if (['cuu', 'cud', 'cuf', 'cub'].includes(name)) {
    if (!Number.isInteger(number(0)) || number(0) < 0) { err(`${name} needs a count`); return 1 }
    out = `${ESC}[${number(0)}${{ cuu: 'A', cud: 'B', cuf: 'C', cub: 'D' }[name]}`
  }
  else if (name === 'setaf' || name === 'setab') {
    out = color(number(0), name === 'setaf' ? 30 : 40)
    if (out === undefined) { err(`${name} needs a color from 0 to 255`); return 1 }
  }
  else if (name in fixed) out = fixed[name]
  else { err(`unknown terminal capability '${name}'`); return 1 }
  writeAll(1, encoder.encode(out))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
