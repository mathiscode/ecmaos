/**
 * The cron daemon: wakes once a minute, like real vixie-cron, and runs any crontab entry whose
 * schedule matches. A job's command line can be a full shell pipeline (`cmd1 | cmd2`), not just a
 * single binary.
 *
 * Re-reads both crontab files whenever their mtime changes (checked every tick), so `cron add`/
 * `remove`'s file edits take effect within a minute with no explicit reload needed, the same as
 * real cron picking up a `crontab -e` change on its own.
 */

import { parseCrontabFile } from './lib/crontab.mjs'
import { parseCronExpression } from 'cron-schedule'

const { exit, custom, stat, env, open, read, close, O_RDONLY } = globalThis.ecmaosSyscalls

const SYSTEM_CRONTAB = '/etc/crontab'
const tickIntervalMs = 60_000

function mtimeOf(path) {
  try { return stat(path).mtimeMs } catch { return undefined }
}

/** One source's live state: its path, the mtime it was last parsed at, and its parsed entries. */
function makeSource(path) {
  return { path, mtime: undefined, entries: [] }
}

function reloadIfChanged(source) {
  const mtime = mtimeOf(source.path)
  if (mtime === undefined) {
    source.mtime = undefined
    source.entries = []
    return
  }
  if (mtime === source.mtime) return

  source.mtime = mtime
  try {
    const fd = open(source.path, O_RDONLY)
    const chunks = []
    try {
      while (true) {
        const buffer = new Uint8Array(65536)
        const n = read(fd, buffer, -1)
        if (n <= 0) break
        chunks.push(buffer.subarray(0, n))
        if (n < 65536) break
      }
    } finally {
      close(fd)
    }
    const content = new TextDecoder().decode(new Uint8Array(chunks.flatMap(c => [...c])))
    source.entries = parseCrontabFile(content)
  } catch (error) {
    custom('klog', 'warn', `crond: failed to read ${source.path}: ${error instanceof Error ? error.message : String(error)}`)
    source.entries = []
  }
}

async function tick(sources, now) {
  for (const source of sources) {
    reloadIfChanged(source)
    for (const entry of source.entries) {
      let matches
      try {
        matches = parseCronExpression(entry.expression).matchDate(now)
      } catch {
        continue
      }
      if (!matches) continue

      // Fire-and-forget: a real crond forks a job and moves on to the next tick without waiting for
      // it, and `shell_exec`'s own `kernel.shell.execute()` call can itself take arbitrarily long
      // (a job that hangs must not stall every other job's schedule).
      custom('shell_exec', entry.command).catch(error => {
        custom('klog', 'warn', `crond: job failed (${entry.expression} ${entry.command}): ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
}

async function main() {
  const home = env['HOME'] ?? '/root'
  const sources = [makeSource(SYSTEM_CRONTAB), makeSource(`${home}/.config/crontab`)]

  // Prime both sources once before the first real tick, so a job scheduled for "now" at boot isn't
  // missed waiting for the first minute boundary.
  for (const source of sources) reloadIfChanged(source)

  // A syslog-style entry, not stdout: `crond` is started backgrounded from `/boot/init`, so a plain
  // `write(1, ...)` here would otherwise resurface in whatever interactive terminal happens to share
  // its session (the actual bug report this replaced) -- `klog` (`main-thread-syscalls.ts`) routes it
  // to `kernel.log`/`/var/log/kernel.log` instead, same as real cron logging to syslog, not its tty.
  await custom('klog', 'info', 'crond: watching for scheduled jobs')

  // Align the first tick to the next minute boundary, then fall back to a plain fixed interval --
  // matching real cron's once-a-minute wake, not millisecond-precise `cron-schedule`-scheduler timing.
  const msToNextMinute = tickIntervalMs - (Date.now() % tickIntervalMs)
  await new Promise(resolve => setTimeout(resolve, msToNextMinute))

  while (true) {
    await tick(sources, new Date())
    await new Promise(resolve => setTimeout(resolve, tickIntervalMs))
  }
}

try {
  await main()
} catch (error) {
  await custom('klog', 'error', `crond: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
