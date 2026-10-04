/**
 * The cron daemon: wakes once a minute, like real vixie-cron, and runs any crontab entry whose
 * schedule matches. A job's command line can be a full shell pipeline (`cmd1 | cmd2`): it is run by
 * `/bin/ecmash -c`, as real cron runs `sh -c`.
 *
 * `/etc/crontab` is root's. Every user in `/etc/passwd` may have a `~/.config/crontab`, whose jobs run
 * as that user, in their home directory, with `HOME`, `USER`, `LOGNAME`, `SHELL` and `PATH` set and no
 * terminal. A user's file is ignored unless that user (or root) owns it. Where the installed
 * `@zenfs/core` cannot run programs as a user, only root's jobs run: running someone else's as root
 * would hand out root.
 *
 * Re-reads the crontab files whenever their mtime changes (checked every tick), so `cron add`/
 * `remove`'s file edits take effect within a minute with no explicit reload needed, the same as
 * real cron picking up a `crontab -e` change on its own.
 *
 * `crond --run USER COMMAND` runs one job as USER the way the daemon would, waits for it and exits
 * with its status. It is for trying a job without waiting for its minute, and for tests.
 */

import { parseCrontabFile } from './lib/crontab.mjs'
import { parseCronExpression } from 'cron-schedule'

const { exit, custom, stat, env, open, read, close, spawn, waitpid, write, argv, O_RDONLY } = globalThis.ecmaosSyscalls

/** A log line nobody waits for; a failure to write it must not become an unhandled rejection that stops the daemon. */
const log = (level, message) => { custom('klog', level, message).catch(() => {}) }

const SYSTEM_CRONTAB = '/etc/crontab'
const tickIntervalMs = 60_000

function mtimeOf(path) {
  try { return stat(path).mtimeMs } catch { return undefined }
}

function readText(path) {
  const fd = open(path, O_RDONLY)
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
  return new TextDecoder().decode(new Uint8Array(chunks.flatMap(c => [...c])))
}

/** `/etc/passwd` as accounts with the groups `/etc/group` lists them in; root is always there. */
function accounts() {
  const groups = []
  try {
    for (const line of readText('/etc/group').split('\n')) {
      const [, , gid, members] = line.split(':')
      if (gid !== undefined && members) groups.push({ gid: Number(gid), members: members.split(',').map(member => member.trim()) })
    }
  } catch { /* no groups */ }
  const list = []
  try {
    for (const line of readText('/etc/passwd').split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue
      const [name, , uid, gid, , home] = line.split(':')
      const account = { name, uid: Number(uid), gid: Number(gid), home: home || '/' }
      account.groups = groups.filter(group => group.members.includes(name) && group.gid !== account.gid).map(group => group.gid)
      list.push(account)
    }
  } catch { /* no passwd */ }
  if (!list.some(account => account.uid === 0)) list.unshift({ name: 'root', uid: 0, gid: 0, home: '/root', groups: [] })
  return list
}

/** One source's live state: its path, whose it is, the mtime it was last parsed at, and its parsed entries. */
function makeSource(path, account) {
  return { path, account, mtime: undefined, entries: [] }
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
    // a file someone else owns is not this account's crontab, whatever it says
    const owner = stat(source.path).uid
    if (owner !== 0 && owner !== source.account.uid) {
      log('warn', `crond: ignoring ${source.path}: not owned by ${source.account.name}`)
      source.entries = []
      return
    }
    source.entries = parseCrontabFile(readText(source.path))
  } catch (error) {
    log('warn', `crond: failed to read ${source.path}: ${error instanceof Error ? error.message : String(error)}`)
    source.entries = []
  }
}

/** Runs `command` as `account` in a shell, with no terminal, and resolves to its exit status. */
async function runJob(account, command) {
  const shell = '/bin/ecmash'
  const jobEnv = { HOME: account.home, USER: account.name, LOGNAME: account.name, SHELL: shell, PATH: env.PATH ?? '/bin:/usr/bin' }
  const pid = await spawn(shell, ['ecmash', '-c', command], { cwd: account.home, env: jobEnv, credentials: { uid: account.uid, gid: account.gid, groups: account.groups } })
  const done = await waitpid(pid, false)
  return done.signal ? 128 + done.signal : done.code
}

/** Every crontab to watch: root's system file, and each account's own when accounts may run jobs. */
function syncSources(sources, runAsUsers) {
  const wanted = new Map()
  const root = { name: 'root', uid: 0, gid: 0, home: '/root', groups: [] }
  wanted.set(SYSTEM_CRONTAB, root)
  for (const account of accounts()) {
    if (account.uid !== 0 && !runAsUsers) continue
    wanted.set(`${account.home}/.config/crontab`, account)
  }
  for (const [path, account] of wanted) {
    const existing = sources.get(path)
    if (!existing || existing.account.uid !== account.uid) sources.set(path, makeSource(path, account))
  }
  for (const path of [...sources.keys()]) if (!wanted.has(path)) sources.delete(path)
}

async function tick(sources, now, runAsUsers) {
  syncSources(sources, runAsUsers)
  for (const source of sources.values()) {
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
      // it (a job that hangs must not stall every other job's schedule).
      const who = source.account.name
      log('info', `crond: (${who}) CMD (${entry.command})`)
      runJob(source.account, entry.command).then(status => {
        if (status !== 0) log('warn', `crond: (${who}) job exited ${status} (${entry.command})`)
      }, error => {
        log('warn', `crond: (${who}) job failed (${entry.expression} ${entry.command}): ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
}

/** `crond --run USER COMMAND`: one job, now, as USER. */
async function runOnce(args) {
  const [name, ...rest] = args
  const account = accounts().find(candidate => candidate.name === name)
  const fail = message => { write(2, new TextEncoder().encode(`crond: ${message}\n`)); return 1 }
  if (!name || rest.length === 0) return fail('usage: crond --run USER COMMAND')
  if (!account) return fail(`user ${name} does not exist`)
  try {
    return await runJob(account, rest.join(' '))
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

async function main() {
  if (argv[1] === '--run') return exit(await runOnce(argv.slice(2)))

  const runAsUsers = await custom('credentials_supported') === 1
  const sources = new Map()
  syncSources(sources, runAsUsers)

  // Prime every source once before the first real tick, so a job scheduled for "now" at boot isn't
  // missed waiting for the first minute boundary.
  for (const source of sources.values()) reloadIfChanged(source)

  // A syslog-style entry, not stdout: `crond` is started backgrounded from `/boot/init`, so a plain
  // `write(1, ...)` here would otherwise resurface in whatever interactive terminal happens to share
  // its session (the actual bug report this replaced) -- `klog` (`main-thread-syscalls.ts`) routes it
  // to `kernel.log`/`/var/log/kernel.log` instead, same as real cron logging to syslog, not its tty.
  await custom('klog', 'info', runAsUsers ? 'crond: watching for scheduled jobs' : 'crond: watching for scheduled jobs (root only: programs cannot run as another user here)')

  // Align the first tick to the next minute boundary, then fall back to a plain fixed interval --
  // matching real cron's once-a-minute wake, not millisecond-precise `cron-schedule`-scheduler timing.
  const msToNextMinute = tickIntervalMs - (Date.now() % tickIntervalMs)
  await new Promise(resolve => setTimeout(resolve, msToNextMinute))

  while (true) {
    await tick(sources, new Date(), runAsUsers)
    await new Promise(resolve => setTimeout(resolve, tickIntervalMs))
  }
}

try {
  await main()
} catch (error) {
  await custom('klog', 'error', `crond: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
