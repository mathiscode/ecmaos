/**
 * Change the runlevel: `telinit N` writes the level to /run/runlevel and tells init (pid 1) to read /etc/inittab again,
 * which stops the entries the level leaves out and starts the ones it brings in. Requires root.
 */

const { exit, write, custom, open, close, writeAll, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const SIGHUP = 1
const out = text => write(2, new TextEncoder().encode(text))
const usage = 'Usage: telinit LEVEL\nLEVEL is one character: the runlevel to switch to. `telinit q` makes init read /etc/inittab again.\n'

try {
  const args = globalThis.ecmaosSyscalls.argv.slice(1)
  if (args[0] === '--help') { write(1, new TextEncoder().encode(usage)); exit(0) }
  if (args.length !== 1 || args[0].length !== 1) { out(`telinit: expected one runlevel\n${usage}`); exit(1) }
  if (args[0] !== 'q' && args[0] !== 'Q') {
    const fd = open('/run/runlevel', O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    try { writeAll(fd, new TextEncoder().encode(`${args[0]}\n`)) } finally { close(fd) }
  }
  await custom('proc_kill', 1, SIGHUP)
  exit(0)
} catch (error) {
  out(`telinit: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(1)
}
