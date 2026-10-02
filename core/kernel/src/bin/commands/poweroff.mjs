/**
 * Power off the system: tell init (pid 1) to stop everything in order, then shut the kernel down.
 * `-f` skips init and stops at once, which is what to use if init is stuck. Requires root.
 */

const { exit, write, custom } = globalThis.ecmaosSyscalls

const SIGUSR2 = 12
const out = text => write(2, new TextEncoder().encode(text))

try {
  const args = globalThis.ecmaosSyscalls.argv.slice(1)
  const force = args.includes('-f') || args.includes('--force')
  const unknown = args.filter(arg => arg !== '-f' && arg !== '--force')
  if (unknown.length) { out(`poweroff: unrecognized option '${unknown[0]}'\nUsage: poweroff [-f]\n`); exit(1) }
  if (force) await custom('system_stop', 'poweroff')
  else await custom('proc_kill', 1, SIGUSR2)
  exit(0)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  out(`poweroff: ${message}\n`)
  exit(1)
}
