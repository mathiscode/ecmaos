/**
 * Real `execve`'d `sleep` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/sleep.ts`) per `feat/1.0.0-execve-commands`. The original polled
 * `terminal.events`'s `INTERRUPT` event to cancel the wait early and return exit code 130 -- no
 * in-band check needed anymore: a real `execve`'d process is killed like any other real process on
 * `^C` (see `cat.mjs`'s doc comment), so a plain `setTimeout`-based wait is all this needs.
 */

const { argv, exit, write } = globalThis.ecmaosSyscalls

const usage = `Usage: sleep NUMBER[SUFFIX]...
Pause for NUMBER seconds.  SUFFIX may be 's' for seconds (the default),
'm' for minutes, 'h' for hours or 'd' for days.

  --help  display this help and exit`

function parseDuration(value) {
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)([smhd]?)$/)
  if (!match?.[1]) return NaN

  const num = parseFloat(match[1])
  if (isNaN(num)) return NaN

  const suffix = match[2] || 's'
  switch (suffix) {
    case 's': return num * 1000
    case 'm': return num * 60 * 1000
    case 'h': return num * 60 * 60 * 1000
    case 'd': return num * 24 * 60 * 60 * 1000
    default: return NaN
  }
}

async function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length === 0) {
    write(2, new TextEncoder().encode('sleep: missing operand\n'))
    write(2, new TextEncoder().encode("Try 'sleep --help' for more information.\n"))
    return 1
  }

  let totalDuration = 0

  for (const arg of args) {
    if (arg.startsWith('-')) {
      write(2, new TextEncoder().encode(`sleep: invalid option -- '${arg.slice(1)}'\n`))
      write(2, new TextEncoder().encode("Try 'sleep --help' for more information.\n"))
      return 1
    }
    const duration = parseDuration(arg)
    if (isNaN(duration)) {
      write(2, new TextEncoder().encode(`sleep: invalid time interval '${arg}'\n`))
      return 1
    }
    totalDuration += duration
  }

  if (totalDuration > 0) await new Promise(resolve => setTimeout(resolve, totalDuration))

  return 0
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`sleep: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
