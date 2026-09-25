/**
 * `crond` -- the real cron daemon, replacing `kernel.intervals`'s cron half (`setCron`/`getCron`/
 * `clearCron`/`listCrons`, the `TimerBasedCronScheduler` from `cron-schedule`) and `kernel.loadCrontab()`
 * entirely. Those held cron jobs as live closures on the main-thread `Kernel` object, calling
 * `kernel.shell.execute()` directly on a schedule computed by `cron-schedule`'s own scheduler -- no
 * pid, invisible to `ps`, unkillable. This is a genuine, long-running `execve`'d worker `Process`
 * instead (started backgrounded from `/boot/init`, the same way a real `crond` is just another
 * daemon process started from init, not a kernel built-in).
 *
 * Scheduling itself needs no main-thread syscall at all -- `setInterval`/`setTimeout` work natively
 * inside a Web Worker, so this wakes once a minute like real vixie-cron and matches each entry's
 * expression against `cron-schedule`'s own `matchDate()`. Running a job's command line *does* need
 * one: `shell_exec` (`#lib/main-thread-syscalls.ts`), since a crontab command can be a full shell
 * pipeline (`cmd1 | cmd2`), and there is no `/bin/sh -c` interpreter in ecmaOS to `proc_spawn` a
 * single resolved binary for -- `kernel.shell.execute()` is the only thing that still understands
 * pipes/redirects, preserving this exactly matches the old scheduler's own behavior.
 *
 * Re-reads both crontab files whenever their mtime changes (checked every tick, like this session's
 * scope decided instead of building real signal delivery into a worker-hosted program just for
 * `cron reload`) -- so `cron add`/`remove`'s plain file edits take effect within a minute with no
 * explicit reload needed, the same as real cron picking up a `crontab -e` change on its own.
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

  // eslint-disable-next-line no-constant-condition
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
