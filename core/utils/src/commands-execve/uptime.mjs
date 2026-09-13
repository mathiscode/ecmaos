/**
 * Real `execve`'d `uptime` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/uptime.ts`) per `feat/1.0.0-execve-commands`. `performance.now()` is a
 * standard Worker global, same source the original used main-thread -- this measures time since
 * *this worker* started, exactly as imprecise/approximate as the original's main-thread reading was.
 */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const usage = `Usage: uptime
Print how long the system has been running.

  --help  display this help and exit`

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  const parts = []
  if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`)
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`)
  if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`)
  if (secs > 0 || parts.length === 0) parts.push(`${secs} second${secs !== 1 ? 's' : ''}`)

  return parts.join(', ')
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length > 0 && args[0] !== '--help' && args[0] !== '-h') {
    writeAll(2, new TextEncoder().encode(`uptime: extra operand '${args[0]}'\nTry 'uptime --help' for more information.\n`))
    return 1
  }

  const uptimeSeconds = performance.now() / 1000
  const uptimeString = formatUptime(uptimeSeconds)
  const now = new Date()

  writeAll(1, new TextEncoder().encode(` ${now.toLocaleTimeString()} up ${uptimeString}\n`))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`uptime: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
