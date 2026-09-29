/**
 * True shell builtins -- the commands (per real Unix precedent: bash's own POSIX "special
 * builtins," `cd`/`export`/`set`/`shift`/`trap`/...) that mutate the *calling shell's own* live
 * state and so can never become a separate `execve`'d file/process, no matter how far the rest of
 * ecmaOS's coreutils migrate. A forked child process changing its own cwd/env/job-table/credentials
 * has zero effect on its parent shell -- that's the whole reason these exist as permanent, in-
 * process exceptions in every real shell. Every other ecmaOS command is a real program under `/bin`.
 *
 * Confirmed by direct code reading (not guessed) which of ecmaOS's existing commands actually
 * belong here: `cd` (`shell.cwd`), `set` (`shell.applyShellOption`), `bg`/`fg`/`jobs`/`wait` (the
 * shell's own job table), `local` (the shell's own call-frame scope), `env`/`export` (`shell.env`/
 * `globalThis.process.env`), `su` (`shell.context`/`shell.credentials`), `read` (assigns into the
 * caller's variables), and `shift`/`source`/`eval` (the caller's positional parameters and its
 * statement stream). `break`/`continue`/`exit`/`return` belong for a different reason: they alter
 * the interpreter's own control flow, which a child process cannot do to its parent -- see
 * `lib/shell-signals.ts`. `theme`/`history` were checked too and found NOT structurally blocked:
 * they are real programs that reach the shell through custom syscalls, not builtins.
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
import type { ShellBuiltinIO, ShellOptionName, User } from '@ecmaos/types'
import { DEFAULT_IFS, splitOnIFS } from '#lib/word-expansion.ts'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal, parseSignalArgument } from '#lib/shell-signals.ts'

export const trueBuiltinNames: ReadonlySet<string> = new Set([
  'cd', 'set', 'bg', 'fg', 'jobs', 'wait', 'local', 'env', 'export', 'read', 'su', 'trap', 'unset',
  ':', '.', 'break', 'continue', 'eval', 'exit', 'return', 'shift', 'source'
])

/**
 * The builtins that run a statement tree in the calling shell rather than acting themselves, so a
 * redirection on them has to apply to everything that tree runs.
 *
 * `Shell.runPipelineStages` holds their redirections as aggregate ones for the duration of the call,
 * the same way it does for a redirected function call or a redirected compound statement. Without
 * that, `source setup.sh > log` would build fds for `source` itself -- which writes nothing but
 * diagnostics -- and let every command in `setup.sh` print to the terminal.
 */
export const aggregateBuiltinNames: ReadonlySet<string> = new Set(['eval', 'source', '.'])

/**
 * Shorthand for the fds every builtin below writes through. Usage text goes to fd 1 and diagnostics
 * to fd 2, the way real shell builtins split them, so `cd /nope 2>/dev/null` is silent and
 * `jobs > f` fills `f`. Both used to go straight to `shell.terminal`, ignoring redirections.
 */
type Io = ShellBuiltinIO

async function runCd(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln('Usage: cd [DIRECTORY]\nChange the shell working directory.\n\n  DIRECTORY  the directory to change to (default: $HOME)\n  --help     display this help and exit')
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
    await io.writelnErr(`cd: ${destination}: ${message}`)
    return 1
  }
}

/**
 * The `set` flags, by the single letter and the `-o` long name that select them -- the same pairs
 * bash uses, so `set -x` and `set -o xtrace` are the same thing.
 */
const SHELL_OPTION_LETTERS: ReadonlyMap<string, ShellOptionName> = new Map([
  ['e', 'errexit'],
  ['u', 'nounset'],
  ['x', 'xtrace'],
  ['f', 'noglob'],
  ['C', 'noclobber'],
  ['v', 'verbose']
])

/** Every long name `set -o` accepts, including `pipefail`, which has no single-letter form. */
const SHELL_OPTION_NAMES: readonly ShellOptionName[] = [
  'errexit', 'noclobber', 'noglob', 'nounset', 'pipefail', 'verbose', 'xtrace'
]

async function runSet(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln([
      'Usage: set [-/+abefCuvx] [-/+o [OPTION]] [ARG...]',
      'Set or unset shell options, or set the positional parameters.',
      '',
      '  -e  errexit    exit on a command that fails outside a condition',
      '  -u  nounset    treat an unset variable as an error',
      '  -x  xtrace     print each command, behind $PS4, before running it',
      '  -f  noglob     turn pathname expansion off',
      '  -C  noclobber  refuse to let > truncate an existing file (>| overrides)',
      '  -v  verbose    echo each line of input as it is read',
      '      pipefail   a pipeline reports its last failing stage, -o only',
      '',
      'Use + instead of - to turn an option off. `set -o` with no name lists them all;',
      '`set -- ARG...` replaces the positional parameters.'
    ].join('\n'))
    return 0
  }

  // `set` with no arguments lists variables in bash. That is what `env` already does here, and
  // printing a second, differently-formatted listing would be the more confusing choice.
  if (argv.length === 0) return 0

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string

    // `set -- a b c` replaces the positional parameters; everything after it is a value, not a flag.
    if (arg === '--') {
      shell.setPositionalParameters([shell.lookupVariable('0') ?? 'ecmaos', ...argv.slice(i + 1)])
      return 0
    }

    if (arg === '-o' || arg === '+o') {
      const name = argv[i + 1]
      // Bare `set -o` lists every option and its state, which is how a script reads them back.
      if (name === undefined || name.startsWith('-') || name.startsWith('+')) {
        if (arg === '-o') for (const option of SHELL_OPTION_NAMES) {
          await io.writeln(`${option.padEnd(12)}${shell.shellOptions[option] ? 'on' : 'off'}`)
        }
        continue
      }

      i++
      if (!(SHELL_OPTION_NAMES as readonly string[]).includes(name)) {
        await io.writelnErr(`set: ${name}: invalid option name`)
        return 2
      }
      shell.applyShellOption(name as ShellOptionName, arg === '-o')
      continue
    }

    if ((arg.startsWith('-') || arg.startsWith('+')) && arg.length > 1) {
      const enable = arg.startsWith('-')
      // A cluster like `set -eux` is one argument setting three flags, as in bash. An `o` inside a
      // cluster still takes the *next* argument as its long name, which is what makes
      // `set -euo pipefail` -- the standard first line of a shell script -- one command.
      let invalid: string | undefined
      for (const letter of arg.slice(1)) {
        if (letter === 'o') {
          const name = argv[++i]
          if (name === undefined || !(SHELL_OPTION_NAMES as readonly string[]).includes(name)) {
            await io.writelnErr(`set: ${name ?? '-o'}: invalid option name`)
            return 2
          }
          shell.applyShellOption(name as ShellOptionName, enable)
          continue
        }
        const option = SHELL_OPTION_LETTERS.get(letter)
        if (!option) { invalid = arg; break }
        shell.applyShellOption(option, enable)
      }
      if (invalid) {
        await io.writelnErr(`set: ${invalid}: invalid option`)
        return 2
      }
      continue
    }

    // A bare word with no leading `-`/`+` is a positional parameter, the same as after `--`.
    shell.setPositionalParameters([shell.lookupVariable('0') ?? 'ecmaos', ...argv.slice(i)])
    return 0
  }

  return 0
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
function jobStatusLabel(job: import('@ecmaos/types').Job): string {
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
  const jobs = shell.listJobs().filter(job => job.background || job.status === 'stopped')
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

async function runLocal(shell: Shell, argv: string[], io: Io): Promise<number> {
  const usage = 'Usage: local NAME[=VALUE]...\nDeclare one or more variables local to the current function call.'
  if (argv[0] === '--help' || argv[0] === '-h') {
    await io.writeln(usage)
    return 0
  }
  // Misuse, not a help request, so the usage text is a diagnostic and belongs on fd 2.
  if (argv.length === 0) {
    await io.writelnErr(usage)
    return 1
  }

  try {
    for (const arg of argv) {
      const eq = arg.indexOf('=')
      if (eq === -1) shell.declareLocal(arg)
      else shell.declareLocal(arg.slice(0, eq), arg.slice(eq + 1))
    }
    return 0
  } catch (error) {
    await io.writelnErr(`local: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
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

  const baseEnv = ignoreEnvironment ? {} : Object.fromEntries(shell.visibleVariables())
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

async function runExport(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln('Usage: export [-n] [-p] [NAME=VALUE | NAME]...\nSet environment variables, or print/unset them.')
    return 0
  }

  const unset = argv.includes('-n')
  const printOnly = argv.includes('-p') || argv.filter(a => a !== '-n' && a !== '-p').length === 0

  if (printOnly) {
    const entries = Array.from(shell.visibleVariables())
      .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
    for (const [key, value] of entries) await io.writeln(`${key}=${value}`)
    return 0
  }

  const assignments = argv.filter(a => a !== '-n' && a !== '-p')
  for (const assignment of assignments) {
    if (unset) {
      const key = assignment.trim()
      if (!key || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) { await io.writelnErr(`export: invalid variable name: ${key}`); return 1 }
      shell.unsetVariable(key)
      continue
    }

    if (!assignment.includes('=')) { await io.writelnErr(`export: invalid assignment: ${assignment}`); return 1 }

    const equalIndex = assignment.indexOf('=')
    const key = assignment.slice(0, equalIndex).trim()
    let value = assignment.slice(equalIndex + 1)

    if (!key || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) { await io.writelnErr(`export: invalid variable name: ${key}`); return 1 }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    // Through `setVariable`, so an active `local` frame is written rather than bypassed. `export`
    // used to write `shell.env` directly: inside a function, `local X=1; export X=2` left the local
    // shadowing `X` untouched at 1 and destroyed the *caller's* `X`, permanently.
    shell.setVariable(key, value)
  }

  return 0
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
  return 0
}

async function runTrap(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln("Usage: trap ['COMMAND'] [SIGNAL...]\n       trap - SIGNAL...\nSet, reset ('-'), or list (no args) signal handlers for this shell.")
    return 0
  }

  if (argv.length === 0) {
    for (const [signal, handler] of shell.listTraps()) await io.writeln(`trap -- '${handler}' ${signal}`)
    return 0
  }

  const [first, ...signals] = argv
  if (signals.length === 0) {
    // `trap` with exactly one arg and no recognized signal name after it isn't valid trap syntax
    // in this shell's subset -- report it rather than silently doing nothing.
    await io.writelnErr(`trap: usage: trap ['COMMAND'] [SIGNAL...]`)
    return 1
  }

  const handler = first === '-' ? undefined : (first as string)
  for (const signal of signals) shell.setTrap(handler, signal)
  return 0
}

/**
 * Splits one input line into the fields `read` assigns, honoring `$IFS`.
 *
 * Differs from word splitting during expansion in one way that matters: when there are fewer names
 * than fields, the final name receives *the rest of the line* rather than just the next field, with
 * its delimiters intact and only leading IFS whitespace trimmed. `read a b <<< "1 2 3"` therefore
 * puts `1` in `a` and `2 3` in `b`, which is what makes `read` usable for parsing.
 *
 * `IFS=` (set but empty) disables splitting entirely, so the line is handed over verbatim -- the
 * reason `while IFS= read -r line` preserves a line's own leading and trailing whitespace.
 */
function readFields(line: string, ifs: string, count: number): string[] {
  // `IFS=` disables splitting, so the line is handed over byte for byte.
  if (ifs === '') return [line]
  // A single name still gets the line with leading and trailing IFS whitespace stripped, which is
  // why `read -r line` trims but `IFS= read -r line` does not.
  if (count <= 1) return [trimIFSWhitespace(line, ifs)]

  const { pieces, hard } = splitOnIFS(line, ifs)
  const fields: string[] = []
  let consumed = 0

  for (let k = 0; k < pieces.length && fields.length < count - 1; k++) {
    const piece = pieces[k] as string
    const boundaryIsHard = k < pieces.length - 1 && (hard[k] as boolean)
    // Skip the empty piece a run of leading IFS whitespace produces; keep the one a non-whitespace
    // delimiter produces, since that is a real empty field.
    if (piece === '' && !boundaryIsHard && fields.length === 0) { consumed = k + 1; continue }
    if (piece === '' && k === pieces.length - 1) break
    fields.push(piece)
    consumed = k + 1
  }

  // Whatever is left of the original line, located by re-joining the pieces we did not take.
  const remainderPieces = pieces.slice(consumed)
  if (remainderPieces.length > 0) {
    const rest = trimIFSWhitespace(rejoinRemainder(line, pieces, consumed), ifs)
    if (rest !== '' || fields.length < count) fields.push(rest)
  }

  while (fields.length < count) fields.push('')
  return fields.slice(0, count)
}

/**
 * The tail of `line` starting at piece `from`, with the original delimiter text between the
 * remaining pieces preserved. Located by measuring how much of `line` the taken pieces and their
 * delimiters account for, since the delimiters themselves are not returned by the splitter.
 */
function rejoinRemainder(line: string, pieces: string[], from: number): string {
  if (from === 0) return line
  let index = 0
  for (let k = 0; k < from; k++) {
    index += (pieces[k] as string).length
    // Step over the delimiter run that followed this piece.
    while (index < line.length && !line.startsWith(pieces[k + 1] as string, index)) {
      index++
      if ((pieces[k + 1] as string) === '') break
    }
  }
  return line.slice(index)
}

/** Strips IFS whitespace (never IFS non-whitespace) from both ends of `text`. */
function trimIFSWhitespace(text: string, ifs: string): string {
  const isTrimmable = (c: string) => (c === ' ' || c === '\t' || c === '\n') && ifs.includes(c)
  let start = 0
  let end = text.length
  while (start < end && isTrimmable(text[start] as string)) start++
  while (end > start && isTrimmable(text[end - 1] as string)) end--
  return text.slice(start, end)
}

async function runRead(shell: Shell, argv: string[], io: Io): Promise<number> {
  const usage = [
    'Usage: read [-r] [-s] [-p PROMPT] [NAME...]',
    'Read one line from standard input and split it into NAMEs using $IFS.',
    '',
    '  -r          do not treat backslash as an escape character',
    '  -s          do not echo input coming from a terminal',
    '  -p PROMPT   write PROMPT before reading, without a trailing newline',
    '  --help      display this help and exit',
    '',
    'With no NAME, the line is assigned to REPLY. Exits non-zero at end of file.'
  ].join('\n')

  let raw = false
  let silent = false
  let prompt: string | undefined
  const names: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--help' || arg === '-h') { await io.writeln(usage); return 0 }
    if (arg === '-r') { raw = true; continue }
    if (arg === '-s') { silent = true; continue }
    if (arg === '-p') {
      prompt = argv[++i]
      if (prompt === undefined) { await io.writelnErr("read: option requires an argument -- 'p'"); return 2 }
      continue
    }
    // `-n`/`-d`/`-t`/`-a` need character-level and timed reads from a terminal, which the current
    // line-oriented editor cannot do. Rejected rather than silently read as a whole line.
    if (/^-[ndta]/.test(arg)) { await io.writelnErr(`read: ${arg}: not supported yet`); return 2 }
    if (arg.startsWith('-') && arg.length > 1) { await io.writelnErr(`read: ${arg}: invalid option`); return 2 }
    names.push(arg)
  }

  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      await io.writelnErr(`read: ${name}: not a valid identifier`)
      return 1
    }
  }

  let line = await io.readLine(prompt !== undefined || silent ? { prompt, silent } : undefined)
  if (line === undefined) return 1

  if (!raw) {
    // Without `-r`, a backslash escapes the next character and disappears. Line continuation is not
    // reachable here: the editor and the stream reader both hand over exactly one line.
    line = line.replace(/\\(.)/g, '$1')
  }

  const ifs = shell.lookupVariable('IFS') ?? DEFAULT_IFS

  if (names.length === 0) {
    // bash assigns REPLY the line unsplit, keeping its whitespace, regardless of $IFS.
    shell.setVariable('REPLY', line)
    return 0
  }

  const fields = readFields(line, ifs, names.length)
  names.forEach((name, index) => shell.setVariable(name, fields[index] ?? ''))
  return 0
}

/**
 * `break [N]` / `continue [N]`.
 *
 * Builtins rather than a special case in `Shell.executeStatements`, which is what they used to be:
 * that check compared the statement's whole trimmed text to `'break'`, so `break 2`, `break;` and
 * `test -d "$d" && break` all missed it and went looking for a `/bin/break`. As builtins they work
 * anywhere a command works, and `N` reaches the right loop -- see `lib/shell-signals.ts`.
 */
async function runBreak(argv: string[], io: Io, keyword: 'break' | 'continue'): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln(`Usage: ${keyword} [N]\n${keyword === 'break' ? 'Exit' : 'Resume'} the Nth enclosing for/while loop (default: 1).`)
    return 0
  }

  const parsed = parseSignalArgument(argv, keyword)
  if (parsed.error) { await io.writelnErr(parsed.error); return 2 }
  // bash treats `break 0` as `break 1` rather than as a no-op.
  const level = Math.max(1, parsed.value ?? 1)
  throw keyword === 'break' ? new BreakSignal(level) : new ContinueSignal(level)
}

/**
 * `exit [N]` -- ends the running script, or the current line at an interactive prompt.
 *
 * With no argument it reports `$?`, which is what makes the `cmd || exit` idiom propagate the real
 * failure code. It does not tear down the terminal session: ecmaOS's login shell is a kernel-owned
 * object with no session-exit path yet, so at the prompt this sets the exit code and stops the line.
 */
async function runExit(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: exit [N]\nExit the current script with status N (default: the status of the last command).')
    return 0
  }

  const parsed = parseSignalArgument(argv, 'exit')
  if (parsed.error) { await io.writelnErr(parsed.error); return 2 }
  throw new ExitSignal(parsed.value ?? Number(shell.env.get('?') ?? 0))
}

/** `return [N]` -- leaves the current function or sourced script, defaulting to `$?` like `exit`. */
async function runReturn(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: return [N]\nReturn from a shell function or sourced script with status N (default: the status of the last command).')
    return 0
  }

  const parsed = parseSignalArgument(argv, 'return')
  if (parsed.error) { await io.writelnErr(parsed.error); return 2 }
  throw new ReturnSignal(parsed.value ?? Number(shell.env.get('?') ?? 0))
}

/** `shift [N]` -- drops the first N positional parameters. Non-zero when N exceeds `$#`, as in bash. */
async function runShift(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: shift [N]\nShift positional parameters left by N (default: 1).')
    return 0
  }

  const raw = argv[0]
  if (raw !== undefined && !/^\d+$/.test(raw)) { await io.writelnErr(`shift: ${raw}: numeric argument required`); return 2 }
  return shell.shiftPositionalParameters(raw === undefined ? 1 : Number(raw)) ? 0 : 1
}

/** `:` -- the null command. Expands its arguments and succeeds, nothing more. */
async function runColon(): Promise<number> {
  return 0
}

/**
 * `eval ARG...` -- joins its arguments with a single space and runs the result as shell input.
 *
 * Runs in the calling shell (`executeSourced`), so `eval 'x=1'` really does set `x`. That is the
 * entire point of `eval`, and the reason it cannot be an `execve`'d program.
 */
async function runEval(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: eval [ARG]...\nConcatenate ARGs into a single command and execute it in the current shell.')
    return 0
  }

  const text = argv.join(' ').trim()
  if (!text) return 0
  try {
    return await shell.executeSourced(text)
  } catch (error) {
    // A control-flow signal is the interpreter unwinding and must pass through; a parse error is
    // `eval`'s own failure to report, the way bash reports a syntax error from eval'd text.
    if (isControlFlowSignal(error)) throw error
    await io.writelnErr(`eval: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

/**
 * `source FILE [ARG...]` and its POSIX spelling `.` -- runs FILE's lines in the calling shell, so
 * functions, variables, aliases and `cd` all persist afterwards. This is what makes `~/.ecmashrc`
 * and `/etc/profile` possible at all.
 *
 * FILE is looked up on `$PATH` when it contains no slash, matching bash, with the working directory
 * as a final fallback so `source ./setup.sh`'s more common spelling `source setup.sh` also works.
 */
async function runSource(shell: Shell, argv: string[], io: Io, keyword: string): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln(`Usage: ${keyword} FILE [ARG]...\nRead and execute FILE's commands in the current shell.`)
    return 0
  }

  const name = argv[0]
  if (!name) { await io.writelnErr(`${keyword}: filename argument required`); return 2 }

  const resolved = await resolveSourcePath(shell, name)
  if (!resolved) { await io.writelnErr(`${keyword}: ${name}: No such file or directory`); return 1 }

  let text: string
  try {
    text = await shell.context.fs.promises.readFile(resolved, 'utf-8')
  } catch (error) {
    await io.writelnErr(`${keyword}: ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const args = argv.slice(1)
  try {
    return await shell.executeSourced(text, args.length > 0 ? args : undefined)
  } catch (error) {
    if (isControlFlowSignal(error)) throw error
    await io.writelnErr(`${keyword}: ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** Whether `error` is one of the four interpreter unwind signals, which a builtin must never swallow. */
function isControlFlowSignal(error: unknown): boolean {
  return error instanceof BreakSignal || error instanceof ContinueSignal ||
    error instanceof ExitSignal || error instanceof ReturnSignal
}

/** `source`'s file lookup: a slash means "use this path", otherwise `$PATH` then the working directory. */
async function resolveSourcePath(shell: Shell, name: string): Promise<string | undefined> {
  const path = await import('path')
  const exists = async (candidate: string) => {
    try { return (await shell.context.fs.promises.stat(candidate)).isFile() } catch { return false }
  }

  const expanded = shell.expandTilde(name)
  if (expanded.includes('/')) {
    const absolute = path.resolve(shell.cwd, expanded)
    return await exists(absolute) ? absolute : undefined
  }

  for (const dir of (shell.env.get('PATH') ?? '').split(':').filter(Boolean)) {
    const candidate = path.resolve(dir, expanded)
    if (await exists(candidate)) return candidate
  }

  const local = path.resolve(shell.cwd, expanded)
  return await exists(local) ? local : undefined
}

async function runUnset(shell: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    await io.writeln([
      'Usage: unset [-f | -v] NAME[[INDEX]]...',
      'Unset a variable, function, or array element.',
      '',
      '  -v      unset variables only',
      '  -f      unset functions only',
      '  --help  display this help and exit'
    ].join('\n'))
    return 0
  }

  const variablesOnly = argv.includes('-v')
  const functionsOnly = argv.includes('-f')
  if (variablesOnly && functionsOnly) {
    await io.writelnErr('unset: cannot simultaneously unset a function and a variable')
    return 1
  }

  for (const arg of argv) {
    if (arg === '-v' || arg === '-f') continue

    const element = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]$/.exec(arg)
    if (element) {
      if (!functionsOnly) shell.unsetArrayElement(element[1] as string, Number(element[2]))
      continue
    }

    if (functionsOnly) { shell.functions.delete(arg); continue }

    if (shell.arrays.has(arg)) { shell.unsetArray(arg); continue }

    // Through `unsetVariable`, so a `local` declaration is what goes rather than the caller's value.
    const hadVariable = shell.lookupVariable(arg) !== undefined
    shell.unsetVariable(arg)
    // bash unsets a variable if one exists by that name and only otherwise falls back to a function,
    // rather than removing both -- `unset PATH` must not delete a `PATH` function too.
    if (!hadVariable && !variablesOnly) shell.functions.delete(arg)
  }

  return 0
}

/** Returns the true-builtin's name if `pipeline`'s sole command is one, else `undefined`. */
export function trueBuiltinNameFor(commandName: string | undefined): string | undefined {
  return commandName && trueBuiltinNames.has(commandName) ? commandName : undefined
}

/**
 * Runs a true shell builtin in-process against the calling `shell` -- never `execve`'d. `io` carries
 * fds 0/1/2, so a builtin honors redirections and works inside a pipeline like any other command.
 */
export async function runTrueBuiltin(shell: Shell, name: string, argv: string[], io: Io): Promise<number> {
  switch (name) {
    case 'cd': return runCd(shell, argv, io)
    case 'set': return runSet(shell, argv, io)
    case 'bg': return runBg(shell, argv, io)
    case 'fg': return runFg(shell, argv, io)
    case 'jobs': return runJobs(shell, argv, io)
    case 'wait': return runWait(shell, argv, io)
    case 'local': return runLocal(shell, argv, io)
    case 'env': return runEnv(shell, argv, io)
    case 'export': return runExport(shell, argv, io)
    case 'read': return runRead(shell, argv, io)
    case 'su': return runSu(shell, argv, io)
    case 'trap': return runTrap(shell, argv, io)
    case 'unset': return runUnset(shell, argv, io)
    case ':': return runColon()
    case 'break': return runBreak(argv, io, 'break')
    case 'continue': return runBreak(argv, io, 'continue')
    case 'eval': return runEval(shell, argv, io)
    case 'exit': return runExit(shell, argv, io)
    case 'return': return runReturn(shell, argv, io)
    case 'shift': return runShift(shell, argv, io)
    case 'source':
    case '.': return runSource(shell, argv, io, name)
    default: throw new Error(`runTrueBuiltin: '${name}' is not a true builtin`)
  }
}
