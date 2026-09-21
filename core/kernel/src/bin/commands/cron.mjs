/**
 * Real `execve`'d `cron` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/cron.ts`) per this session's M1 pass, alongside `crond.mjs` (the real
 * scheduler daemon this command's file-editing subcommands feed). `list`/`add`/`remove`/`validate`/
 * `next`/`test` are all plain crontab-file reads/writes plus pure expression parsing -- exactly
 * `crontab -l`/`-e`-shaped, needing no live query of `crond` at all, since `crond` re-reads both
 * crontab files on its own whenever their mtime changes (see its own doc comment). `edit` is the one
 * subcommand needing a syscall: it opens a real editor as a child process and waits for it, through
 * the new `proc_spawn`/`proc_wait` syscalls (`#lib/main-thread-syscalls.ts`) -- the first real
 * consumer of that fork+exec+wait primitive in this session.
 *
 * `reload` no longer clears/reloads a live in-memory registry (there is not one to clear -- `crond`
 * owns its own schedule entirely) -- it is now purely informational, since `crond`'s own per-minute
 * mtime check already does what an explicit reload used to force immediately. Building a real signal
 * (`SIGHUP`) round trip into `crond` was scoped out this session: `node.mjs`'s worker-hosted programs
 * have no signal-delivery surface exposed to them at all yet.
 *
 * No `cronstrue` here, unlike the legacy command -- found the hard way, mid-session: bundled in, it
 * pushed this program past the real `data:` URL import-size limit that also broke `stat.mjs`'s
 * original `zip.js` use (see that file's own doc comment), and the actual threshold turned out to be
 * much lower than previously assumed there (`theme.mjs`, 34KB, imports fine; this file at 90KB with
 * `cronstrue` did not -- confirmed via a real booted-kernel test, not just an isolated esbuild
 * `build()` call, which reported no error at all despite the runtime failure). `cronstrue` alone
 * bundles to ~61KB, so this drops the human-readable schedule descriptions it used to print
 * alongside the raw cron expression rather than trying to shave the rest of the program down instead.
 */

import { parseCrontabFile } from './lib/crontab.mjs'
import { parseCronExpression } from 'cron-schedule'

const { argv, exit, write, custom, open, read, close, writeAll, mkdir, stat, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, env } = globalThis.ecmaosSyscalls

const usage = `Usage: cron [COMMAND] [OPTIONS]

Manage scheduled tasks (crontabs). Actual scheduling is done by the crond
daemon (see /boot/init) -- this command reads/writes crontab files and
inspects cron expressions.

Options:
  --help  display this help and exit

Commands:
  list                    List all crontab entries (system and user)
  add <schedule> <cmd>    Add a new cron job to the user crontab
  remove <id>             Remove a cron job by ID (e.g. cron:user:2)
  edit                    Open the user crontab in an editor
  validate <expression>   Validate a cron expression
  next <expression> [N]   Show next N execution times (default: 1)
  test <expression>       Test if expression matches current time
  reload                  Informational: crond picks up file changes on its own

Examples:
  cron list                                    List all cron jobs
  cron add "*/5 * * * *" "echo hello"          Add job to run every 5 minutes
  cron remove cron:user:1                      Remove user cron job #1
  cron validate "*/5 * * * *"                  Validate cron expression
  cron next "*/5 * * * *" 5                    Show next 5 execution times
  cron test "*/5 * * * *"                      Test if expression matches now`

function writeStdout(text) { write(1, new TextEncoder().encode(text + '\n')) }
function writeStderr(text) { write(2, new TextEncoder().encode(text + '\n')) }

function exists(path) {
  try { stat(path); return true } catch { return false }
}

function readFile(path) {
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

function writeFile(path, content) {
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try {
    writeAll(fd, new TextEncoder().encode(content))
  } finally {
    close(fd)
  }
}

function userCrontabPath() {
  const home = env['HOME'] ?? '/root'
  return `${home}/.config/crontab`
}

async function cmdList() {
  const jobs = []

  if (exists('/etc/crontab')) {
    for (const entry of parseCrontabFile(readFile('/etc/crontab'))) {
      jobs.push({ name: `cron:system:${entry.lineNumber}`, ...entry })
    }
  }

  const userPath = userCrontabPath()
  if (exists(userPath)) {
    for (const entry of parseCrontabFile(readFile(userPath))) {
      jobs.push({ name: `cron:user:${entry.lineNumber}`, ...entry })
    }
  }

  if (jobs.length === 0) {
    writeStdout('No cron jobs configured.')
    return 0
  }

  writeStdout('Configured cron jobs:')
  for (const job of jobs) {
    writeStdout(`  ${job.name}`)
    writeStdout(`    Schedule: ${job.expression}`)
    writeStdout(`    Command: ${job.command}`)
  }
  return 0
}

async function cmdAdd(args) {
  if (args.length < 2) {
    writeStderr('cron add: missing arguments')
    writeStderr('Usage: cron add <schedule> <command>')
    return 1
  }

  const schedule = args[0]
  const command = args.slice(1).join(' ')

  try {
    parseCronExpression(schedule)
  } catch {
    writeStderr(`cron add: invalid cron expression: ${schedule}`)
    return 1
  }

  const home = env['HOME'] ?? '/root'
  const configDir = `${home}/.config`
  if (!exists(configDir)) mkdir(configDir, 0o777)

  const crontabPath = userCrontabPath()
  let content = exists(crontabPath) ? readFile(crontabPath) : ''
  if (content.length > 0 && !content.endsWith('\n')) content += '\n'
  content += `${schedule} ${command}\n`
  writeFile(crontabPath, content)

  writeStdout(`Added cron job: ${schedule} ${command}`)
  writeStdout('crond will pick this up within a minute.')
  return 0
}

async function cmdRemove(args) {
  const jobId = args[0]
  if (!jobId) {
    writeStderr('cron remove: missing job ID')
    writeStderr('Usage: cron remove <id>')
    return 1
  }

  if (!jobId.startsWith('cron:user:')) {
    writeStderr(`cron remove: only user jobs can be removed (got ${jobId})`)
    return 1
  }

  const lineNumber = parseInt(jobId.replace('cron:user:', ''), 10)
  const crontabPath = userCrontabPath()
  if (!exists(crontabPath)) {
    writeStderr(`cron remove: job not found: ${jobId}`)
    return 1
  }

  const content = readFile(crontabPath)
  const lines = content.split('\n')
  const entries = parseCrontabFile(content)
  const entryToRemove = entries.find(e => e.lineNumber === lineNumber)

  if (!entryToRemove) {
    writeStderr(`cron remove: job not found: ${jobId}`)
    return 1
  }

  const newLines = lines.filter((_, idx) => idx + 1 !== lineNumber)
  writeFile(crontabPath, newLines.join('\n'))
  writeStdout(`Removed cron job: ${jobId}`)
  return 0
}

async function cmdEdit() {
  const crontabPath = userCrontabPath()
  const home = env['HOME'] ?? '/root'
  const configDir = `${home}/.config`
  if (!exists(configDir)) mkdir(configDir, 0o777)

  // Same `$EDITOR`/`$VISUAL` convention real `crontab -e` uses -- `proc_spawn` needs an already-
  // resolved path (real `execve` semantics, no PATH search), so this fails with a real `ENOENT`
  // through the syscall (see `proc_spawn`'s own doc comment) if none of these exist, the same way
  // real `crontab -e` fails clearly when no editor is configured, rather than silently no-op'ing.
  const editor = env['EDITOR'] || env['VISUAL'] || '/usr/bin/vi'
  const pid = await custom('proc_spawn', editor, JSON.stringify([editor, crontabPath]), '')
  const code = await custom('proc_wait', pid)
  if (code === 0) writeStdout('Crontab edited. crond will pick up the change within a minute.')
  return code
}

function cmdValidate(args) {
  const expression = args[0]
  if (!expression) {
    writeStderr('cron validate: missing expression')
    writeStderr('Usage: cron validate <expression>')
    return 1
  }
  try {
    parseCronExpression(expression)
    writeStdout(`Valid cron expression: ${expression}`)
    return 0
  } catch (error) {
    writeStderr(`Invalid cron expression: ${expression}`)
    writeStderr(`Error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function cmdNext(args) {
  const expression = args[0]
  if (!expression) {
    writeStderr('cron next: missing expression')
    writeStderr('Usage: cron next <expression> [count]')
    return 1
  }
  const count = args.length > 1 && args[1] ? parseInt(args[1], 10) : 1
  if (isNaN(count) || count < 1) {
    writeStderr('cron next: invalid count (must be >= 1)')
    return 1
  }

  try {
    const cron = parseCronExpression(expression)
    const now = new Date()
    const dates = cron.getNextDates(count, now)
    writeStdout(`Next ${count} execution time(s) for "${expression}":`)
    dates.forEach((date, i) => writeStdout(`  ${i + 1}. ${date.toISOString()}`))
    return 0
  } catch (error) {
    writeStderr(`Invalid cron expression: ${expression}`)
    writeStderr(`Error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function cmdTest(args) {
  const expression = args[0]
  if (!expression) {
    writeStderr('cron test: missing expression')
    writeStderr('Usage: cron test <expression>')
    return 1
  }
  try {
    const cron = parseCronExpression(expression)
    const now = new Date()
    const matches = cron.matchDate(now)
    writeStdout(matches
      ? `Expression "${expression}" matches current time: ${now.toISOString()}`
      : `Expression "${expression}" does not match current time: ${now.toISOString()}`)
    return 0
  } catch (error) {
    writeStderr(`Invalid cron expression: ${expression}`)
    writeStderr(`Error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function main() {
  const args = argv.slice(1)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    writeStderr(usage)
    return 0
  }

  const [subcommand, ...rest] = args

  switch (subcommand) {
    case 'list': return await cmdList()
    case 'add': return await cmdAdd(rest)
    case 'remove': return await cmdRemove(rest)
    case 'edit': return await cmdEdit()
    case 'validate': return cmdValidate(rest)
    case 'next': return cmdNext(rest)
    case 'test': return cmdTest(rest)
    case 'reload':
      writeStdout('crond checks crontab files for changes every minute on its own; nothing to force here.')
      return 0
    default:
      writeStderr(`cron: unknown command: ${subcommand}`)
      writeStderr("Try 'cron --help' for more information.")
      return 1
  }
}

try {
  exit(await main())
} catch (error) {
  writeStderr(`cron: error: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
