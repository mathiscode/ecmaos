/**
 * `at`, `atq`, `atrm` and `batch`: queue a job to run once, list the queue, remove jobs. A job is a shell script in
 * `/var/spool/cron/atjobs/N`, owned by the user (mode 0700), that sets the environment, umask and working directory at
 * queue time and then runs the commands; `crond` runs it as its owner when it is due and removes it. What it prints goes
 * to the system log under the tag `at`, since there is no mail to send it by (`-m` is refused, `-M` accepted). It runs
 * with the setuid bit so the spool can be root's; `/etc/at.allow` and `/etc/at.deny` decide who may use it. `batch` runs
 * the job now: there is no load average to wait on.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readFdText, readTextFile } from './lib/fs-text.mjs'
import { makePriv } from './lib/priv.mjs'
import { parseAtTime, parseTouchTime } from './lib/at-time.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, getuid, getcwd, open, close, writeAll, mkdir, chown, chmod, unlink, stat, readdir, umask, O_WRONLY, O_CREAT, O_TRUNC } = sys
const encoder = new TextEncoder()
const name = (argv[0] ?? 'at').split('/').pop()
const priv = makePriv(sys, name)
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`${name}: ${text}\n`))

const SPOOL = '/var/spool/cron/atjobs'
const SEQUENCE = `${SPOOL}/.SEQ`

const usage = `Usage: at [-V] [-q x] [-f file] [-u username] [-mMlbv] timespec ...
       at [-V] [-q x] [-f file] [-u username] [-mMlbv] -t time
       at -c job ...
       atq [-V] [-q x]
       at [ -rd ] job ...
       atrm [-V] job ...
       batch`

/** Variables at does not carry into a job: they describe the shell or terminal that queued it */
const NOT_KEPT = new Set(['TERM', 'DISPLAY', '_', 'SHELLOPTS', 'BASH_VERSINFO', 'EUID', 'GROUPS', 'PPID', 'UID', 'SHLVL', 'OLDPWD', 'COLUMNS', 'LINES'])

const quote = text => `'${String(text).replace(/'/g, "'\\''")}'`
const readOrUndefined = path => { try { return readTextFile(path) } catch { return undefined } }

/** What an `at -l` line says about a time: `Tue Oct 27 15:00:00 2026` */
function stamp(ms) {
  const date = new Date(ms)
  const [day, month, dayOfMonth, year, time] = date.toString().split(' ')
  return `${day} ${month} ${dayOfMonth} ${time} ${year}`
}

/** Whether `user` may queue jobs: listed in at.allow when it exists, else not listed in at.deny */
function allowed(user) {
  if (user.uid === 0) return true
  const names = text => text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  const allow = readOrUndefined('/etc/at.allow')
  if (allow !== undefined) return names(allow).includes(user.name)
  const deny = readOrUndefined('/etc/at.deny')
  return deny === undefined || !names(deny).includes(user.name)
}

/** `# at: user=NAME uid=N gid=N time=MS queue=Q`, as crond reads it */
function headerOf(text) {
  const line = text.split('\n').find(candidate => candidate.startsWith('# at: '))
  if (!line) return undefined
  const fields = Object.fromEntries(line.slice(6).trim().split(/\s+/).map(pair => pair.split('=')))
  return { user: fields.user, uid: Number(fields.uid), gid: Number(fields.gid), time: Number(fields.time), queue: fields.queue ?? 'a' }
}

/** Every queued job the caller may see: their own, or all of them for root */
function jobs(caller) {
  let names
  try { names = readdir(SPOOL) } catch { return [] }
  const list = []
  for (const file of names) {
    if (!/^\d+$/.test(file)) continue
    const text = readOrUndefined(`${SPOOL}/${file}`)
    const header = text && headerOf(text)
    if (!header || (caller.uid !== 0 && header.uid !== caller.uid)) continue
    list.push({ id: Number(file), text, ...header })
  }
  return list.sort((a, b) => a.time - b.time || a.id - b.id)
}

function ensureSpool() {
  for (const [path, mode] of [['/var/spool/cron', 0o755], [SPOOL, 0o700]]) {
    try { stat(path) } catch { mkdir(path, mode) }
  }
}

/** The next job number, kept in the spool so a removed job's number is not given again */
function nextId() {
  const last = Number((readOrUndefined(SEQUENCE) ?? '0').trim()) || 0
  const id = last + 1
  const fd = open(SEQUENCE, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
  try { writeAll(fd, encoder.encode(`${id}\n`)) } finally { close(fd) }
  return id
}

function list(caller, queue) {
  for (const job of jobs(caller)) {
    if (queue && job.queue !== queue) continue
    out(`${job.id}\t${stamp(job.time)} ${job.queue} ${job.user}\n`)
  }
  return 0
}

function remove(caller, ids) {
  if (ids.length === 0) { err('no job specified'); return 1 }
  let status = 0
  const mine = new Map(jobs(caller).map(job => [String(job.id), job]))
  for (const id of ids) {
    if (!mine.has(String(Number(id)))) {
      // a job that is there but someone else's reads the same as one that is not, as at says it
      writeAll(2, encoder.encode(`Cannot find jobid ${id}\n`))
      status = 1
      continue
    }
    unlink(`${SPOOL}/${Number(id)}`)
  }
  return status
}

function show(caller, ids) {
  let status = 0
  const mine = new Map(jobs(caller).map(job => [String(job.id), job]))
  for (const id of ids) {
    const job = mine.get(String(Number(id)))
    if (!job) { writeAll(2, encoder.encode(`Cannot find jobid ${id}\n`)); status = 1; continue }
    out(job.text)
  }
  return status
}

/** The script for a job: the environment, umask and directory at queue time, then the commands */
function script(user, time, queue, commands) {
  const exports = Object.entries(env)
    .filter(([key]) => !NOT_KEPT.has(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${quote(value)}; export ${key}`)
  const cwd = getcwd()
  return [
    '#!/bin/sh',
    `# at: user=${user.name} uid=${user.uid} gid=${user.gid} time=${time} queue=${queue}`,
    `umask ${(umask() & 0o777).toString(8).padStart(3, '0')}`,
    ...exports,
    `cd ${quote(cwd)} || {`,
    `\techo 'Execution directory inaccessible' >&2`,
    '\texit 1',
    '}',
    commands.endsWith('\n') ? commands : commands + '\n'
  ].join('\n')
}

async function main() {
  const asName = name === 'atq' ? 'l' : name === 'atrm' ? 'r' : undefined
  const { options, operands, error } = getopt(argv.slice(1), { short: 'Vq:f:u:mMlbvrdct:', long: { help: 'h' }, permute: false })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp(name) + '\n')); return 1 }
  let action = asName ?? (name === 'batch' ? 'b' : undefined)
  let queue
  let file
  let touch
  let verbose = false
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'V') { writeAll(2, encoder.encode('at version 3.2.5 (ecmaOS)\n')); if (!operands.length && !action) return 0; continue }
    if (key === 'q') {
      if (!/^[a-zA-Z=]$/.test(value)) { err('invalid queue name'); return 1 }
      queue = value
    } else if (key === 'f') file = value
    else if (key === 't') touch = value
    else if (key === 'v') verbose = true
    else if (key === 'm') { err('there is no mail to send job output by; it goes to the system log (journalctl -t at)'); return 1 }
    else if (key === 'u') { err('-u is not supported: a job runs as the user who queues it'); return 1 }
    else if (key === 'M') { /* no mail is sent anyway */ }
    else if (key === 'l' || key === 'r' || key === 'd' || key === 'c' || key === 'b') action = key === 'd' ? 'r' : key
  }

  const found = priv.lookup(getuid())
  if (!found) { err('cannot find your user name'); return 1 }
  const caller = priv.withGroups(found)
  if (!allowed(caller)) { err('you do not have permission to use this program'); return 1 }

  if (action === 'l') return list(caller, queue)
  if (action === 'r') return remove(caller, operands)
  if (action === 'c') return show(caller, operands)

  let time
  if (action === 'b') time = Date.now()
  else if (touch !== undefined) time = parseTouchTime(touch)
  else {
    if (operands.length === 0) { writeAll(2, encoder.encode('Garbled time\n')); return 1 }
    time = parseAtTime(operands.join(' '))
  }
  if (Number.isNaN(time)) { writeAll(2, encoder.encode('Garbled time\n')); return 1 }
  if (time < Date.now() - 60_000) { writeAll(2, encoder.encode('at: refusing to create job destined in the past\n')); return 1 }

  let commands
  try {
    if (file !== undefined) {
      // the file is read as the caller could read it, not as root
      const info = stat(file)
      if (caller.uid !== 0 && info.uid !== caller.uid && !(info.mode & 0o004) && !((info.mode & 0o040) && caller.gids.includes(info.gid))) { err(`${file}: Permission denied`); return 1 }
      commands = readTextFile(file)
    } else commands = readFdText(0)
  } catch (e) { err(`${file ?? 'stdin'}: ${reasonOf(e)}`); return 1 }

  ensureSpool()
  const id = nextId()
  const path = `${SPOOL}/${id}`
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o700)
  try { writeAll(fd, encoder.encode(script(caller, time, queue ?? (action === 'b' ? 'b' : 'a'), commands))) } finally { close(fd) }
  chmod(path, 0o700)
  chown(path, caller.uid, caller.gid)
  if (verbose) out(`${stamp(time)}\n\n`)
  writeAll(2, encoder.encode(`warning: commands will be executed using /bin/sh\njob ${id} at ${stamp(time)}\n`))
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
