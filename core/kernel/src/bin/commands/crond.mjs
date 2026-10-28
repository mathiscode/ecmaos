/**
 * The cron daemon, and atd. Wakes once a minute and runs any crontab entry whose schedule matches. A job's command line
 * runs through `/bin/ecmash -c`.
 * `/etc/crontab` is root's. A user's crontab is `/var/spool/cron/crontabs/USER`, which `crontab` installs, or the older
 * `~/.config/crontab`; it runs as that user, in their home, with `HOME`, `USER`, `LOGNAME`, `SHELL` and `PATH` set and
 * no terminal, and is ignored unless that user or root owns it. Where the installed `@zenfs/core` cannot run programs as
 * a user, only root's jobs run.
 * Crontab files are re-read when their mtime changes (checked every tick). `@reboot` entries run once a boot, when crond
 * first starts (`/run` is emptied at boot, and the marker is kept there).
 * The jobs `at` queues in `/var/spool/cron/atjobs` are looked at every few seconds; a due one runs as its owner through
 * `systemd-cat -t at`, so what it prints reaches the system log (there is no mail to send it by), and is then removed.
 * `crond --run USER COMMAND` runs one job as USER, waits and exits with its status; for trying a job and for tests.
 */

import { parseCrontabFile } from './lib/crontab.mjs'
import { parseCronExpression } from 'cron-schedule'

const { exit, custom, stat, env, open, read, close, spawn, waitpid, write, argv, readdir, unlink, O_RDONLY, O_WRONLY, O_CREAT } = globalThis.ecmaosSyscalls

/**
 * A log line nobody waits for; a failure to write it must not become an unhandled rejection that stops the daemon.
 */
const log = (level, message) => { custom('klog', level, message).catch(() => {}) }

const SYSTEM_CRONTAB = '/etc/crontab'
const SPOOL = '/var/spool/cron/crontabs'
const AT_SPOOL = '/var/spool/cron/atjobs'
const REBOOT_MARKER = '/run/crond.reboot'
const tickIntervalMs = 60_000
const atIntervalMs = 5_000

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
    wanted.set(`${SPOOL}/${account.name}`, account)
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
      if (entry.reboot) continue
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

/** The `@reboot` entries, once a boot: the marker in `/run` says they have run. */
function runRebootEntries(sources) {
  try { stat(REBOOT_MARKER); return } catch { /* not yet this boot */ }
  try { close(open(REBOOT_MARKER, O_WRONLY | O_CREAT, 0o644)) } catch { return }
  for (const source of sources.values()) {
    for (const entry of source.entries) {
      if (!entry.reboot) continue
      const who = source.account.name
      log('info', `crond: (${who}) CMD (${entry.command})`)
      runJob(source.account, entry.command).catch(error => log('warn', `crond: (${who}) @reboot job failed (${entry.command}): ${error instanceof Error ? error.message : String(error)}`))
    }
  }
}

/** `# at: user=NAME uid=N gid=N time=MS queue=Q` from a job file's head, or undefined */
function atHeader(text) {
  const line = text.split('\n').find(candidate => candidate.startsWith('# at: '))
  if (!line) return undefined
  const fields = Object.fromEntries(line.slice(6).trim().split(/\s+/).map(pair => pair.split('=')))
  const header = { user: fields.user, uid: Number(fields.uid), gid: Number(fields.gid), time: Number(fields.time), queue: fields.queue ?? 'a' }
  return Number.isFinite(header.uid) && Number.isFinite(header.time) ? header : undefined
}

/** Jobs being run, by file, so the next look does not start one twice */
const runningAt = new Set()

/** Runs each `at` job that is due, as its owner, and removes it once it has run. */
function runDueAtJobs(runAsUsers) {
  let names
  try { names = readdir(AT_SPOOL) } catch { return }
  const now = Date.now()
  for (const name of names) {
    if (!/^\d+$/.test(name) || runningAt.has(name)) continue
    const path = `${AT_SPOOL}/${name}`
    let header
    try { header = atHeader(readText(path)) } catch { continue }
    if (!header || header.time > now) continue
    const owner = (() => { try { return stat(path).uid } catch { return undefined } })()
    if (owner !== header.uid && owner !== 0) { log('warn', `crond: ignoring at job ${name}: not owned by ${header.user}`); continue }
    if (header.uid !== 0 && !runAsUsers) continue
    const account = accounts().find(candidate => candidate.uid === header.uid) ?? { name: header.user, uid: header.uid, gid: header.gid, home: '/', groups: [] }
    runningAt.add(name)
    log('info', `atd: (${account.name}) job ${name}`)
    const jobEnv = { HOME: account.home, USER: account.name, LOGNAME: account.name, SHELL: '/bin/ecmash', PATH: env.PATH ?? '/bin:/usr/bin' }
    const finished = () => { runningAt.delete(name); try { unlink(path) } catch { /* removed meanwhile */ } }
    spawn('/bin/systemd-cat', ['systemd-cat', '-t', 'at', '/bin/ecmash', path], { cwd: account.home, env: jobEnv, credentials: { uid: account.uid, gid: account.gid, groups: account.groups } })
      .then(pid => waitpid(pid, false))
      .then(done => {
        const status = done.signal ? 128 + done.signal : done.code
        if (status !== 0) log('warn', `atd: (${account.name}) job ${name} exited ${status}`)
      }, error => log('warn', `atd: (${account.name}) job ${name} failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(finished)
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
  if (argv[1] === '--help' || argv[1] === '-h') {
    write(1, new TextEncoder().encode('Usage: crond\n       crond --run USER COMMAND\nThe cron daemon, started by /boot/init; --run runs one job as USER now and exits with its status.\n'))
    return exit(0)
  }
  if (argv[1] === '--run') return exit(await runOnce(argv.slice(2)))

  const runAsUsers = await custom('credentials_supported') === 1
  const sources = new Map()
  syncSources(sources, runAsUsers)

  // Prime every source once before the first real tick, so a job scheduled for "now" at boot isn't
  // missed waiting for the first minute boundary.
  for (const source of sources.values()) reloadIfChanged(source)
  runRebootEntries(sources)
  runDueAtJobs(runAsUsers)
  setInterval(() => runDueAtJobs(runAsUsers), atIntervalMs)

  // Logged through `klog` to `kernel.log` instead of stdout, so a daemon's messages do not appear in an interactive
  // terminal.
  await custom('klog', 'info', runAsUsers ? 'crond: watching for scheduled jobs' : 'crond: watching for scheduled jobs (root only: programs cannot run as another user here)')

  // Align the first tick to the next minute boundary, then fall back to a plain fixed interval -
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
