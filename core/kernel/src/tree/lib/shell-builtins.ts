/**
 * The kernel shell's builtins. Most of them live in `@ecmaos/coreutils/lib/shell-core/builtins` and
 * run here through {@link kernelBuiltinHost}; what stays is what touches the kernel's own machinery:
 * the job table (`jobs`, `fg`, `bg`, `wait`), `su`, and `env`, which runs a command.
 *
 * These are the commands (per real Unix precedent: bash's own POSIX "special builtins") that mutate
 * the *calling shell's own* live state and so can never become a separate `execve`'d program: a forked
 * child changing its own cwd or variables has no effect on its parent. Every other ecmaOS command is a
 * real program under `/bin`.
 *
 * Dispatched from `Shell.execute` before any `$PATH` lookup, as bash checks its builtin table first.
 * `Kernel.registerCommands` writes no `/bin/<name>` file for any of these names.
 */

import chalk from 'chalk'
import { bindContext, createCredentials } from '@zenfs/core'
import type { Shell } from '#shell.ts'
import type { ShellBuiltinIO, User } from '@ecmaos/types'
import { sharedBuiltinNames, runSharedBuiltin, shellQuote, type BuiltinHost } from '@ecmaos/coreutils/lib/shell-core/builtins'
import path from 'path'

const kernelOnlyNames = ['bg', 'fg', 'jobs', 'wait', 'env', 'su']

export const trueBuiltinNames: ReadonlySet<string> = new Set([...sharedBuiltinNames, ...kernelOnlyNames])

/**
 * The builtins that run a statement tree in the calling shell rather than acting themselves, so a
 * redirection on them has to apply to everything that tree runs.
 *
 * `Shell.runPipelineStages` holds their redirections as aggregate ones for the duration of the call,
 * the same way it does for a redirected function call or a redirected compound statement. Without
 * that, `source setup.sh > log` would build fds for `source` itself -- which writes nothing but
 * diagnostics -- and let every command in `setup.sh` print to the terminal.
 *
 * `env` and `command` belong here for the same reason: `env FOO=bar cmd > log` and
 * `command ls > log` both run their real work through `shell.execute`, which builds its own streams.
 */
export const aggregateBuiltinNames: ReadonlySet<string> = new Set(['eval', 'source', '.', 'env', 'command'])

/**
 * Shorthand for the fds every builtin below writes through. Usage text goes to fd 1 and diagnostics
 * to fd 2, the way real shell builtins split them, so `cd /nope 2>/dev/null` is silent and
 * `jobs > f` fills `f`.
 */
type Io = ShellBuiltinIO

/** What the shared builtins need from the kernel shell. */
export function kernelBuiltinHost(shell: Shell): BuiltinHost {
  return {
    state: shell.state,
    interpreter: shell.interpreter,
    cwd: () => shell.cwd,
    chdir: async target => {
      try {
        const stat = await shell.context.fs.promises.stat(target)
        if (!stat.isDirectory()) return 'Not a directory'
        shell.cwd = target
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    resolvePath: input => path.resolve(shell.cwd, input),
    expandTilde: input => shell.expandTilde(input),
    stat: async target => {
      try {
        const stat = await shell.context.fs.promises.stat(target)
        return { file: stat.isFile(), directory: stat.isDirectory(), size: Number(stat.size) }
      } catch { return undefined }
    },
    readFile: target => shell.context.fs.promises.readFile(target, 'utf-8'),
    positional: () => shell.positionalParameters,
    setPositional: args => shell.setPositionalParameters([shell.env.get('0') ?? 'ecmaos', ...args]),
    getStatus: () => Number(shell.env.get('?') ?? 0),
    describe: name => shell.describeCommand(name),
    runArgv: argv => shell.execute(argv.map(shellQuote).join(' ')),
    changed: () => shell.publishEnv(),
  }
}

async function runBg(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln('Usage: bg [%JOBSPEC]\nResume a stopped job in the background, without waiting for it.')
    return 0
  }

  const spec = argv[0]
  const job = shell.getJob(spec)
  if (!job) {
    await io.writelnErr(spec ? `bg: ${spec}: no such job` : 'bg: no current job')
    return 1
  }
  if (job.status !== 'stopped') {
    await io.writelnErr(`bg: job ${job.id} already in background`)
    return 1
  }

  shell.bg(spec)
  return 0
}

async function runFg(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln('Usage: fg [%JOBSPEC]\nResume a stopped or backgrounded job in the foreground and wait for it.')
    return 0
  }

  const spec = argv[0]
  if (spec && !shell.getJob(spec)) {
    await io.writelnErr(`fg: ${spec}: no such job`)
    return 1
  }
  if (!spec && !shell.getJob()) {
    await io.writelnErr('fg: no current job')
    return 1
  }

  const code = await shell.fg(spec)
  return code ?? 1
}

/** bash-style status label: `Running`, `Stopped`, or `Done`. */
export function jobStatusLabel(job: import('@ecmaos/types').Job): string {
  switch (job.status) {
    case 'running': return 'Running'
    case 'stopped': return 'Stopped'
    case 'done': return `Done${job.exitCodes && job.exitCodes.some(code => code !== 0) ? `(${job.exitCodes[job.exitCodes.length - 1]})` : ''}`
  }
}

async function runJobs(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln("Usage: jobs [-l]\nList the shell's tracked background/foreground jobs.")
    return 0
  }

  const showPids = argv.includes('-l')
  const jobs = shell.listJobs().filter(job => !job.notified && (job.background || job.status === 'stopped'))
  if (jobs.length === 0) return 0

  const mostRecentId = jobs[jobs.length - 1]?.id
  const previousId = jobs.length > 1 ? jobs[jobs.length - 2]?.id : undefined

  for (const job of jobs) {
    const marker = job.id === mostRecentId ? '+' : job.id === previousId ? '-' : ' '
    const pids = showPids && job.processes.length > 0 ? ` (${job.processes.map(p => p.pid).join(', ')})` : ''
    const suffix = job.background ? ' &' : ''
    await io.writeln(`[${job.id}]${marker}  ${jobStatusLabel(job).padEnd(24)}${job.commandLine}${suffix}${pids}`)
  }

  return 0
}

async function runWait(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln('Usage: wait [%JOBSPEC | PID]\nWait for a background job (or every tracked one) to finish.')
    return 0
  }

  const spec = argv[0]
  if (spec && !shell.getJob(spec)) {
    await io.writelnErr(`wait: ${spec}: no such job or process`)
    return 1
  }

  const code = await shell.wait(spec)
  return code ?? 0
}

async function runEnv(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.length > 0 && (argv[0] === '--help' || argv[0] === '-h')) {
    await io.writeln('Usage: env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]\nSet each NAME to VALUE in the environment and run COMMAND.')
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
        if (!varName) { await io.writelnErr("env: option requires an argument -- 'u'"); return 1 }
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

  // `env` lists, and passes on, only what the shell exports: a plain `X=1` is not part of the environment.
  const baseEnv = ignoreEnvironment ? {} : Object.fromEntries([...shell.visibleVariables()].filter(([key]) => shell.state.isExported(key)))
  for (const varName of unsetVars) delete baseEnv[varName]
  const modifiedEnv = { ...baseEnv, ...envVars }

  if (commandStartIndex === -1) {
    const entries = Object.entries(modifiedEnv).sort(([a], [b]) => a.localeCompare(b))
    const separator = nullTerminated ? '\0' : '\n'
    let output = ''
    for (const [key, value] of entries) output += `${key}=${value}${separator}`
    if (!nullTerminated && entries.length > 0) output += '\n'
    if (output) await io.write(output)
    return 0
  }

  const commandArgs = argv.slice(commandStartIndex)
  const command = commandArgs[0]
  if (!command) { await io.writelnErr('env: missing command'); return 1 }

  const originalEnv = new Map(shell.env)

  for (const [key, value] of Object.entries(modifiedEnv)) shell.env.set(key, value)
  for (const varName of unsetVars) shell.env.delete(varName)
  shell.publishEnv()

  try {
    const exitCode = await shell.execute(commandArgs.join(' '))
    return exitCode ?? 1
  } finally {
    // `globalThis.process.env` needs no separate save/restore: it is a mirror of the owning shell's
    // environment, republished from it, not a second copy to keep in step by hand.
    shell.env.clear()
    for (const [key, value] of originalEnv.entries()) shell.env.set(key, value)
    shell.publishEnv()
  }
}

async function runSu(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln('Usage: su [USER]\nSwitch user.')
    return 0
  }

  const username = argv[0]
  const currentUser = shell.users.get(shell.credentials.suid) as User
  if (!currentUser || shell.credentials.suid !== 0) {
    await io.writelnErr(chalk.red(shell.i18n.t('Unauthorized')))
    return 1
  }

  const user = Array.from(shell.users.all.values()).find((u): u is User => (u as User).username === username)
  if (!user) {
    await io.writelnErr(chalk.red(shell.i18n.t('User not found', { username })))
    return 1
  }

  shell.context = bindContext({ root: '/', pwd: '/', credentials: user })
  shell.credentials = createCredentials({ uid: user.uid, gid: user.gid, suid: currentUser.uid, sgid: currentUser.gid, euid: user.uid, egid: user.gid, groups: user.groups })
  shell.terminal.promptTemplate = '{user}:{cwd}{sigil} '
  await shell.recordLogin(user.username)
  return 0
}

/** Returns the true-builtin's name if `commandName` is one, else `undefined`. */
export function trueBuiltinNameFor(commandName: string | undefined): string | undefined {
  return commandName && trueBuiltinNames.has(commandName) ? commandName : undefined
}

/**
 * Runs a true shell builtin in-process against the calling `shell` -- never `execve`'d. `io` carries
 * fds 0/1/2, so a builtin honors redirections and works inside a pipeline like any other command.
 */
export async function runTrueBuiltin(shell: Shell, name: string, argv: string[], io: Io): Promise<number> {
  switch (name) {
    case 'bg': return runBg(shell, argv, io)
    case 'fg': return runFg(shell, argv, io)
    case 'jobs': return runJobs(shell, argv, io)
    case 'wait': return runWait(shell, argv, io)
    case 'env': return runEnv(shell, argv, io)
    case 'su': return runSu(shell, argv, io)
  }
  if (sharedBuiltinNames.has(name)) return runSharedBuiltin(kernelBuiltinHost(shell), name, argv, io)
  throw new Error(`runTrueBuiltin: '${name}' is not a true builtin`)
}
