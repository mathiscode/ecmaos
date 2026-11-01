/** `reset`: put the terminal back to a sane state: a full reset, then the modes a program may have left changed. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()

const args = argv.slice(1)
if (args.includes('-V') || args.includes('--version')) { writeAll(1, encoder.encode('reset (ecmaOS coreutils) 1.0\n')); exit(0) }
if (args.includes('-h') || args.includes('--help')) {
  writeAll(1, encoder.encode('Usage: reset [-IQqVs] [-e ch] [-i ch] [-k ch] [-m mapping] [terminal]\n\nReset the terminal: leave the alternate screen and raw modes, show the cursor, and clear the screen.\n'))
  exit(0)
}
if (args.includes('-q')) { writeAll(1, encoder.encode(`${globalThis.ecmaosSyscalls.env.TERM ?? 'xterm-256color'}\n`)); exit(0) }

// RIS (a full reset), then: soft reset, normal cursor keys and keypad, no mouse reporting or bracketed paste, cursor shown
const sequence = '\x1bc\x1b[!p\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[0m'
writeAll(1, encoder.encode(sequence))
exit(0)
