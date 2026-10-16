/**
 * The kernel shell's builtins. Most live in `@ecmaos/coreutils/lib/shell-core/builtins` and run through {@link
 * kernelBuiltinHost}; what stays touches kernel machinery: the job table (`jobs`, `fg`, `bg`, `wait`) and `env`.
 * These mutate the calling shell's own state, so they cannot be separate programs. Dispatched from `Shell.execute`
 * before any `$PATH` lookup; no `/bin/<name>` file exists for them.
 */

import type { Shell } from '#shell.ts'
import type { ShellBuiltinIO } from '@ecmaos/types'
import { currentStorageLimits } from './storage-limits.ts'
import { sharedBuiltinNames, runSharedBuiltin, shellQuote, type BuiltinHost } from '@ecmaos/coreutils/lib/shell-core/builtins'
import path from 'path'

const kernelOnlyNames = ['bg', 'fg', 'jobs', 'wait', 'disown']

export const trueBuiltinNames: ReadonlySet<string> = new Set([...sharedBuiltinNames, ...kernelOnlyNames])

/**
 * The builtins that run a statement tree in the calling shell, so a redirection on them applies to everything the
 * tree runs. `Shell.runPipelineStages` holds their redirections as aggregate ones. `env` and `command` are here
 * because they run their work through `shell.execute`.
 */
export const aggregateBuiltinNames: ReadonlySet<string> = new Set(['eval', 'source', '.', 'command'])

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
        const code = (error as { code?: string }).code
        const reason: Record<string, string> = { ENOENT: 'No such file or directory', ENOTDIR: 'Not a directory', EACCES: 'Permission denied', ELOOP: 'Too many levels of symbolic links' }
        return (code && reason[code]) || (error instanceof Error ? error.message : String(error))
      }
    },
    realpath: target => shell.context.fs.promises.realpath(target) as Promise<string>,
    resolvePath: input => path.resolve(shell.cwd, input),
    expandTilde: input => shell.expandTilde(input),
    stat: async target => {
      try {
        const stat = await shell.context.fs.promises.stat(target)
        return { file: stat.isFile(), directory: stat.isDirectory(), size: Number(stat.size) }
      } catch { return undefined }
    },
    fileInfo: async (target, follow) => {
      try {
        const info = follow ? await shell.context.fs.promises.stat(target) : await shell.context.fs.promises.lstat(target)
        return {
          mode: Number(info.mode), uid: Number(info.uid), gid: Number(info.gid), dev: Number(info.dev), ino: Number(info.ino),
          size: Number(info.size), atimeMs: Number(info.atimeMs), mtimeMs: Number(info.mtimeMs)
        }
      } catch { return undefined }
    },
    identity: () => ({ uid: shell.credentials.euid, gid: shell.credentials.egid, groups: shell.credentials.groups }),
    readFile: target => shell.context.fs.promises.readFile(target, 'utf-8'),
    listDir: dir => shell.context.fs.promises.readdir(dir),
    builtinNames: () => trueBuiltinNames,
    writeFile: (target, text) => shell.context.fs.promises.writeFile(target, text),
    removeFile: target => shell.context.fs.promises.unlink(target),
    positional: () => shell.positionalParameters,
    setPositional: args => shell.setPositionalParameters([shell.env.get('0') ?? 'ecmaos', ...args]),
    getStatus: () => Number(shell.env.get('?') ?? 0),
    describe: name => shell.describeCommand(name),
    runArgv: argv => shell.execute(argv.map(shellQuote).join(' ')),
    changed: () => shell.publishEnv(),
    // the built-in shell is what a login runs, so it is always a login shell
    isLoginShell: () => true,
    fileSizeLimit: () => {
      const { maxFileBytes } = currentStorageLimits()
      return maxFileBytes === false ? undefined : maxFileBytes
    },
    umask: mask => {
      const old = shell.umask
      if (mask !== undefined) shell.umask = mask
      return old
    },
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
/** What bash calls a job that a signal ended, by signal number */
const SIGNAL_LABELS: Record<number, string> = { 1: 'Hangup', 2: 'Interrupt', 3: 'Quit', 6: 'Aborted', 9: 'Killed', 10: 'User defined signal 1', 12: 'User defined signal 2', 13: 'Broken pipe', 14: 'Alarm clock', 15: 'Terminated' }

export function jobStatusLabel(job: import('@ecmaos/types').Job): string {
  switch (job.status) {
    case 'running': return 'Running'
    case 'stopped': return 'Stopped'
    case 'done': {
      const last = job.exitCodes?.[job.exitCodes.length - 1]
      if (last !== undefined && SIGNAL_LABELS[last - 128]) return SIGNAL_LABELS[last - 128] as string
      return `Done${job.exitCodes && job.exitCodes.some(code => code !== 0) ? `(${last})` : ''}`
    }
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
    await io.writeln(`[${job.id}]${marker}  ${jobStatusLabel(job).padEnd(27)}${job.commandLine}${suffix}${pids}`)
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
    await io.writelnErr(spec.startsWith('%') ? `wait: ${spec}: no such job` : `wait: pid ${spec} is not a child of this shell`)
    return 127
  }

  const code = await shell.wait(spec)
  return code ?? 0
}

async function runDisown(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln('Usage: disown [-a] [%JOBSPEC | PID]...\nForget jobs: they leave the job table and no longer print a Done notice.')
    return 0
  }

  if (argv.includes('-a')) {
    for (const job of shell.listJobs()) shell.removeJob(job)
    return 0
  }

  const specs = argv.length > 0 ? argv : [undefined]
  let status = 0
  for (const spec of specs) {
    const job = shell.getJob(spec)
    if (!job) {
      await io.writelnErr(spec ? `disown: ${spec}: no such job` : 'disown: no current job')
      status = 1
      continue
    }
    shell.removeJob(job)
  }
  return status
}

/** Returns the true-builtin's name if `commandName` is one, else `undefined`. */
export function trueBuiltinNameFor(commandName: string | undefined): string | undefined {
  return commandName && trueBuiltinNames.has(commandName) ? commandName : undefined
}

/**
 * Runs a true shell builtin in-process against the calling `shell` - never `execve`'d. `io` carries
 * fds 0/1/2, so a builtin honors redirections and works inside a pipeline like any other command.
 */
export async function runTrueBuiltin(shell: Shell, name: string, argv: string[], io: Io): Promise<number> {
  switch (name) {
    case 'bg': return runBg(shell, argv, io)
    case 'fg': return runFg(shell, argv, io)
    case 'jobs': return runJobs(shell, argv, io)
    case 'wait': return runWait(shell, argv, io)
    case 'disown': return runDisown(shell, argv, io)
  }
  if (sharedBuiltinNames.has(name)) return runSharedBuiltin(kernelBuiltinHost(shell), name, argv, io)
  throw new Error(`runTrueBuiltin: '${name}' is not a true builtin`)
}
