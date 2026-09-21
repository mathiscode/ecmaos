/**
 * Real `execve`'d `load-crontab` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/load-crontab.ts`) per this session's M1 pass. `kernel.loadCrontab()`
 * mutates `kernel.intervals`' live cron-job registry (real `setInterval` handles can't cross a
 * worker boundary) and, on each job firing, calls `kernel.shell.execute()` -- both main-thread-only,
 * reached through the new `crontab_load` custom syscall (`#lib/main-thread-syscalls.ts`).
 */

const { argv, exit, write, custom } = globalThis.ecmaosSyscalls

const usage = `Usage: load-crontab PATH SCOPE
Load and register crontab entries from PATH, replacing any previously loaded from that SCOPE.

  SCOPE  'system' or 'user'

  --help  display this help and exit

Examples:
  load-crontab /etc/crontab system
  load-crontab ~/.config/crontab user`

function writeStderr(text) { write(2, new TextEncoder().encode(text + '\n')) }

/** Same small worker-local `~`/`~/rest` expansion `tee.mjs`/`sed.mjs` use, replacing `shell.expandTilde()`. */
function expandTilde(input) {
  const home = globalThis.ecmaosSyscalls.env['HOME'] ?? '/root'
  if (input === '~') return home
  if (input.startsWith('~/')) return home + input.slice(1)
  return input
}

async function main() {
  const args = argv.slice(1)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    writeStderr(usage)
    return args.length === 0 ? 1 : 0
  }

  const [rawPath, scope] = args
  if (!rawPath || (scope !== 'system' && scope !== 'user')) {
    writeStderr(`load-crontab: SCOPE must be 'system' or 'user'`)
    writeStderr(usage)
    return 1
  }

  const filePath = expandTilde(rawPath)
  await custom('crontab_load', filePath, scope)
  return 0
}

try {
  exit(await main())
} catch (error) {
  writeStderr(`load-crontab: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
