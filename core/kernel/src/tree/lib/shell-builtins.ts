/**
 * True shell builtins -- the ~10 commands (per real Unix precedent: bash's own POSIX "special
 * builtins," `cd`/`export`/`set`/`shift`/`trap`/...) that mutate the *calling shell's own* live
 * state and so can never become a separate `execve`'d file/process, no matter how far the rest of
 * ecmaOS's coreutils migrate. A forked child process changing its own cwd/env/job-table/credentials
 * has zero effect on its parent shell -- that's the whole reason these exist as permanent, in-
 * process exceptions in every real shell, not a temporary gap the way ecmaOS's other 98+12 legacy
 * commands are.
 *
 * Confirmed by direct code reading (not guessed) which of ecmaOS's existing commands actually
 * belong here: `cd` (`shell.cwd`), `set` (`shell.applyShellOption`), `bg`/`fg`/`jobs`/`wait` (the
 * shell's own job table), `local` (the shell's own call-frame scope), `env`/`export` (`shell.env`/
 * `globalThis.process.env`), `su` (`shell.context`/`shell.credentials`). `theme`/`history` were
 * checked too and found NOT structurally blocked (cosmetic/display config a future syscall could
 * plausibly bridge) -- they stay in the legacy shim, not here.
 *
 * Dispatched from `Shell.execute` exactly the way `functionNameFor`/`callFunction` already dispatch
 * a registered shell function -- checked before any `$PATH`/`resolveCommand` file lookup happens at
 * all, matching bash checking its builtin table before searching `$PATH`. `Kernel.registerCommands`
 * writes no `/bin/<name>` file for any of these names (see its own doc comment) -- exactly like real
 * bash, which has no `/bin/cd`.
 */

import chalk from 'chalk'
import { bindContext, createCredentials } from '@zenfs/core'
import type { Shell } from '#shell.ts'
import type { User } from '@ecmaos/types'

export const trueBuiltinNames: ReadonlySet<string> = new Set([
  'cd', 'set', 'bg', 'fg', 'jobs', 'wait', 'local', 'env', 'export', 'su'
])

/** Writes a line to the shell's own terminal -- these run with no real `Process`/`CommandIO` at all. */
function writeln(shell: Shell, text: string): void {
  shell.terminal.writeln(text)
}

async function runCd(shell: Shell, argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    writeln(shell, 'Usage: cd [DIRECTORY]\nChange the shell working directory.\n\n  DIRECTORY  the directory to change to (default: $HOME)\n  --help     display this help and exit')
    return 0
  }

  const path = await import('path')
  const destination = argv.length > 0 && argv[0] && !argv[0].startsWith('-') ? argv[0] : shell.cwd
  const fullPath = destination ? path.resolve(shell.cwd, destination) : shell.cwd

  try {
    await shell.context.fs.promises.access(fullPath)
    shell.cwd = fullPath
    localStorage.setItem(`cwd:${shell.credentials.uid}`, fullPath)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeln(shell, `cd: ${destination}: ${message}`)
    return 1
  }
}

function runSet(shell: Shell, argv: string[]): number {
  if (argv[0] === '--help' || argv[0] === '-h') {
    writeln(shell, 'Usage: set [-e|+e] [-u|+u] [-o pipefail|+o pipefail]\nConfigure shell options for the current shell.')
    return 0
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '-e') shell.applyShellOption('errexit', true)
    else if (arg === '+e') shell.applyShellOption('errexit', false)
    else if (arg === '-u') shell.applyShellOption('nounset', true)
    else if (arg === '+u') shell.applyShellOption('nounset', false)
    else if (arg === '-o' || arg === '+o') {
      const option = argv[++i]
      if (option !== 'pipefail') {
        writeln(shell, `set: unsupported option: ${option ?? '<missing>'}`)
        return 1
      }
      shell.applyShellOption('pipefail', arg === '-o')
    } else {
      writeln(shell, `set: unsupported option: ${arg}`)
      return 1
    }
  }

  return 0
}

function runBg(shell: Shell, argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeln(shell, 'Usage: bg [%JOBSPEC]\nResume a stopped job in the background, without waiting for it.')
    return 0
  }

  const spec = argv[0]
  const job = shell.getJob(spec)
  if (!job) {
    writeln(shell, spec ? `bg: ${spec}: no such job` : 'bg: no current job')
    return 1
  }
  if (job.status !== 'stopped') {
    writeln(shell, `bg: job ${job.id} already in background`)
    return 1
  }

  shell.bg(spec)
  return 0
}

async function runFg(shell: Shell, argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeln(shell, 'Usage: fg [%JOBSPEC]\nResume a stopped or backgrounded job in the foreground and wait for it.')
    return 0
  }

  const spec = argv[0]
  if (spec && !shell.getJob(spec)) {
    writeln(shell, `fg: ${spec}: no such job`)
    return 1
  }
  if (!spec && !shell.getJob()) {
    writeln(shell, 'fg: no current job')
    return 1
  }

  const code = await shell.fg(spec)
  return code ?? 1
}

/** bash-style status label: `Running`, `Stopped`, or `Done`. */
function jobStatusLabel(job: import('@ecmaos/types').Job): string {
  switch (job.status) {
    case 'running': return 'Running'
    case 'stopped': return 'Stopped'
    case 'done': return `Done${job.exitCodes && job.exitCodes.some(code => code !== 0) ? `(${job.exitCodes[job.exitCodes.length - 1]})` : ''}`
  }
}

function runJobs(shell: Shell, argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeln(shell, "Usage: jobs [-l]\nList the shell's tracked background/foreground jobs.")
    return 0
  }

  const showPids = argv.includes('-l')
  const jobs = shell.listJobs().filter(job => job.background || job.status === 'stopped')
  if (jobs.length === 0) return 0

  const mostRecentId = jobs[jobs.length - 1]?.id
  const previousId = jobs.length > 1 ? jobs[jobs.length - 2]?.id : undefined

  for (const job of jobs) {
    const marker = job.id === mostRecentId ? '+' : job.id === previousId ? '-' : ' '
    const pids = showPids && job.processes.length > 0 ? ` (${job.processes.map(p => p.pid).join(', ')})` : ''
    const suffix = job.background ? ' &' : ''
    writeln(shell, `[${job.id}]${marker}  ${jobStatusLabel(job).padEnd(24)}${job.commandLine}${suffix}${pids}`)
  }

  return 0
}

async function runWait(shell: Shell, argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeln(shell, 'Usage: wait [%JOBSPEC | PID]\nWait for a background job (or every tracked one) to finish.')
    return 0
  }

  const spec = argv[0]
  if (spec && !shell.getJob(spec)) {
    writeln(shell, `wait: ${spec}: no such job or process`)
    return 1
  }

  const code = await shell.wait(spec)
  return code ?? 0
}

function runLocal(shell: Shell, argv: string[]): number {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    writeln(shell, 'Usage: local NAME[=VALUE]...\nDeclare one or more variables local to the current function call.')
    return argv.length === 0 ? 1 : 0
  }

  try {
    for (const arg of argv) {
      const eq = arg.indexOf('=')
      if (eq === -1) shell.declareLocal(arg)
      else shell.declareLocal(arg.slice(0, eq), arg.slice(eq + 1))
    }
    return 0
  } catch (error) {
    writeln(shell, `local: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function runEnv(shell: Shell, argv: string[]): Promise<number> {
  if (argv.length > 0 && (argv[0] === '--help' || argv[0] === '-h')) {
    writeln(shell, 'Usage: env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]\nSet each NAME to VALUE in the environment and run COMMAND.')
    return 0
  }

  let ignoreEnvironment = false
  const unsetVars: string[] = []
  let nullTerminated = false
  const envVars: Record<string, string> = {}
  let commandStartIndex = -1

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (!arg) { i++; continue }

    if (arg === '-i' || arg === '--ignore-environment') ignoreEnvironment = true
    else if (arg === '-0' || arg === '--null') nullTerminated = true
    else if (arg === '-u' || arg.startsWith('--unset=')) {
      let varName: string
      if (arg.startsWith('--unset=')) varName = arg.slice(8)
      else {
        i++
        varName = argv[i] || ''
        if (!varName) { writeln(shell, "env: option requires an argument -- 'u'"); return 1 }
      }
      if (varName) unsetVars.push(varName)
    } else if (arg.includes('=')) {
      const [name, ...valueParts] = arg.split('=')
      if (name && valueParts.length > 0) envVars[name] = valueParts.join('=')
    } else {
      commandStartIndex = i
      break
    }
    i++
  }

  const baseEnv = ignoreEnvironment ? {} : Object.fromEntries(shell.env.entries())
  for (const varName of unsetVars) delete baseEnv[varName]
  const modifiedEnv = { ...baseEnv, ...envVars }

  if (commandStartIndex === -1) {
    const entries = Object.entries(modifiedEnv).sort(([a], [b]) => a.localeCompare(b))
    const separator = nullTerminated ? '\0' : '\n'
    let output = ''
    for (const [key, value] of entries) output += `${key}=${value}${separator}`
    if (!nullTerminated && entries.length > 0) output += '\n'
    if (output) shell.terminal.write(output)
    return 0
  }

  const commandArgs = argv.slice(commandStartIndex)
  const command = commandArgs[0]
  if (!command) { writeln(shell, 'env: missing command'); return 1 }

  const originalEnv = new Map(shell.env)
  const originalProcessEnv = { ...globalThis.process.env }

  for (const [key, value] of Object.entries(modifiedEnv)) {
    shell.env.set(key, value)
    globalThis.process.env[key] = value
  }
  for (const varName of unsetVars) {
    shell.env.delete(varName)
    delete globalThis.process.env[varName]
  }

  try {
    const exitCode = await shell.execute(commandArgs.join(' '))
    return exitCode ?? 1
  } finally {
    shell.env.clear()
    for (const [key, value] of originalEnv.entries()) shell.env.set(key, value)
    for (const key in globalThis.process.env) if (!(key in originalProcessEnv)) delete globalThis.process.env[key]
    for (const [key, value] of Object.entries(originalProcessEnv)) globalThis.process.env[key] = value
  }
}

function runExport(shell: Shell, argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeln(shell, 'Usage: export [-n] [-p] [NAME=VALUE | NAME]...\nSet environment variables, or print/unset them.')
    return 0
  }

  const unset = argv.includes('-n')
  const printOnly = argv.includes('-p') || argv.filter(a => a !== '-n' && a !== '-p').length === 0

  if (printOnly) {
    const entries = Array.from(shell.env.entries())
      .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
    for (const [key, value] of entries) writeln(shell, `${key}=${value}`)
    return 0
  }

  const assignments = argv.filter(a => a !== '-n' && a !== '-p')
  for (const assignment of assignments) {
    if (unset) {
      const key = assignment.trim()
      if (!key || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) { writeln(shell, `export: invalid variable name: ${key}`); return 1 }
      shell.env.delete(key)
      delete globalThis.process.env[key]
      continue
    }

    if (!assignment.includes('=')) { writeln(shell, `export: invalid assignment: ${assignment}`); return 1 }

    const equalIndex = assignment.indexOf('=')
    const key = assignment.slice(0, equalIndex).trim()
    let value = assignment.slice(equalIndex + 1)

    if (!key || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) { writeln(shell, `export: invalid variable name: ${key}`); return 1 }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    shell.env.set(key, value)
    globalThis.process.env[key] = value
  }

  return 0
}

function runSu(shell: Shell, argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeln(shell, 'Usage: su [USER]\nSwitch user.')
    return 0
  }

  const username = argv[0]
  const currentUser = shell.users.get(shell.credentials.suid) as User
  if (!currentUser || shell.credentials.suid !== 0) {
    writeln(shell, chalk.red(shell.i18n.t('Unauthorized')))
    return 1
  }

  const user = Array.from(shell.users.all.values()).find((u): u is User => (u as User).username === username)
  if (!user) {
    writeln(shell, chalk.red(shell.i18n.t('User not found', { username })))
    return 1
  }

  shell.context = bindContext({ root: '/', pwd: '/', credentials: user })
  shell.credentials = createCredentials({ uid: user.uid, gid: user.gid, suid: currentUser.uid, sgid: currentUser.gid, euid: user.uid, egid: user.gid, groups: user.groups })
  shell.terminal.promptTemplate = `{user}:{cwd}${user.uid === 0 ? '#' : '$'} `
  return 0
}

/** Returns the true-builtin's name if `pipeline`'s sole command is one, else `undefined`. */
export function trueBuiltinNameFor(commandName: string | undefined): string | undefined {
  return commandName && trueBuiltinNames.has(commandName) ? commandName : undefined
}

/** Runs a true shell builtin in-process against the calling `shell` -- never `execve`'d. */
export async function runTrueBuiltin(shell: Shell, name: string, argv: string[]): Promise<number> {
  switch (name) {
    case 'cd': return runCd(shell, argv)
    case 'set': return runSet(shell, argv)
    case 'bg': return runBg(shell, argv)
    case 'fg': return runFg(shell, argv)
    case 'jobs': return runJobs(shell, argv)
    case 'wait': return runWait(shell, argv)
    case 'local': return runLocal(shell, argv)
    case 'env': return runEnv(shell, argv)
    case 'export': return runExport(shell, argv)
    case 'su': return runSu(shell, argv)
    default: throw new Error(`runTrueBuiltin: '${name}' is not a true builtin`)
  }
}
