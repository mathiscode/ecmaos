/**
  * @experimental
  * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
  * 
  * The Shell class handles the Terminal environment and interaction with the Kernel.
  * 
 */

import { DEFAULT_UMASK } from './lib/umask-store.ts'
import path from 'path'
import { parse } from 'smol-toml'
import { bindContext } from '@zenfs/core'
import type { BoundContext, Credentials } from '@zenfs/core'
import { fromDev, Process as ZenFSProcess, Signal } from '@zenfs/linux'
import type {
  Filesystem, Job, JobProcessHandle, JobStatus, KernelContext,
  Shell as IShell, ShellBuiltinIO, ShellCreatePipeStream, ShellExecute, ShellOptionName, ShellOptions, TerminalConfig as ITerminalConfig, Terminal as ITerminal, Users
} from '@ecmaos/types'
import { ThemePresets } from '@ecmaos/types'

import type { ReadLineOptions } from '@ecmaos/coreutils/lib/shell-core/builtins'
import { printfBytes } from '@ecmaos/coreutils/lib/printf-format'
import { ParseError, parseRedirections, stripComments, tokenize, tokenizeConditional } from '@ecmaos/coreutils/lib/shell-parser'
import type { Command as ParsedCommand, Pipeline, Redirection, WordPart } from '@ecmaos/coreutils/lib/shell-parser'
import { CONTROL_FLOW_KEYWORDS, ControlFlowParseError, parseRunnable, parseStatements } from '@ecmaos/coreutils/lib/control-flow-parser'
import type { Redirected, Statement } from '@ecmaos/coreutils/lib/control-flow-parser'
import { aggregateBuiltinNames, jobStatusLabel, kernelBuiltinHost, runTrueBuiltin, trueBuiltinNameFor } from '#lib/shell-builtins.ts'
import { testExpression, shellQuote } from '@ecmaos/coreutils/lib/shell-core/builtins'
import { SessionLog } from '#lib/sessions.ts'
import { pairStreams } from '#lib/stream-twins.ts'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from '@ecmaos/coreutils/lib/shell-core/signals'
import { ShellState } from '@ecmaos/coreutils/lib/shell-core/state'
import { startupFiles } from '@ecmaos/coreutils/lib/shell-core/startup-files'
import { promptCommands } from '@ecmaos/coreutils/lib/shell-core/prompt-command'
import { isControlFlowSignal } from '@ecmaos/coreutils/lib/shell-core/builtins'
import { signalNameOf } from '@ecmaos/coreutils/lib/shell-core/signal-table'
import { Interpreter, type InterpreterHost } from '@ecmaos/coreutils/lib/shell-core/interpreter'
import { applyArrayAssignment, parseArrayAssignment, splitAssignments, type Assignment } from '@ecmaos/coreutils/lib/shell-core/prepare'
import { expandWordFieldsBraced, expandWordString, expandHeredocBody, UnboundVariableError, type ExpansionContext } from '@ecmaos/coreutils/lib/word-expansion'
import { globPaths, globRegExp, hasGlobCharacters, type GlobOptions } from '@ecmaos/coreutils/lib/glob'
import { evaluateConditional, type ConditionalFs } from '@ecmaos/coreutils/lib/conditional-eval'

/**
 * The one shell whose environment `globalThis.process.env` mirrors; `Kernel.switchTty` hands it over with the active
 * TTY.
 */
let processEnvOwner: object | undefined

/**
 * Names kept in a shell's environment `Map` that are shell state and must not reach a child: `$?`, the positional
 * parameters and the other one-character specials.
 */

/**
 * Index of the first top-level (unquoted, not nested in `$(...)`) `;`, `&` or `|` in `text`, or -1. Splits a leading
 * `VAR=value` from the rest of the line.
 */
function findTopLevelOperatorIndex(text: string): number {
  let depth = 0
  let i = 0
  while (i < text.length) {
    const char = text[i] as string

    if (char === '\\' && i + 1 < text.length) {
      i += 2
      continue
    }

    if (char === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) return -1
      i = end + 1
      continue
    }

    if (char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' && j + 1 < text.length ? 2 : 1
      if (j >= text.length) return -1
      i = j + 1
      continue
    }

    if (char === '(') { depth++; i++; continue }
    if (char === ')') { depth = Math.max(0, depth - 1); i++; continue }
    if (depth === 0 && (char === ';' || char === '&' || char === '|')) return i

    i++
  }

  return -1
}

/**
 * Whether reading this character device is EOF at once: only `/dev/null` (device 1:3), which the filesystem layer
 * cannot express itself.
 */
function readsAsEof(rdev: number): boolean {
  const { major, minor } = fromDev(rdev)
  return major === 1 && minor === 3
}

/**
 * A line-oriented view of one input stream whose buffer outlives a single read, so successive `read` builtins in a
 * redirected loop share one position. Only builtins read it.
 */
/** What `jobs` shows for a compound command, whose source text is not kept. */
function compoundLabel(statement: Statement): string {
  switch (statement.type) {
    case 'subshell': return '( ... )'
    case 'group': return '{ ...; }'
    case 'if': return 'if ...; fi'
    case 'case': return 'case ...; esac'
    case 'while': return `${statement.until ? 'until' : 'while'} ...; done`
    case 'for': case 'cfor': return 'for ...; done'
    case 'select': return 'select ...; done'
    default: return '...'
  }
}

/** A pipe that buffers everything written, so the writer never waits for the reader. */
function unboundedPipe(): { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> } {
  const queue: Uint8Array[] = []
  let closed = false
  let wake: (() => void) | undefined
  const notify = () => { const resolve = wake; wake = undefined; resolve?.() }
  const readable = new ReadableStream<Uint8Array>({
    pull: async controller => {
      while (queue.length === 0 && !closed) await new Promise<void>(resolve => { wake = resolve })
      const next = queue.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
    cancel: () => { queue.length = 0; closed = true }
  }, { highWaterMark: 0 })
  const writable = new WritableStream<Uint8Array>({
    write: chunk => { queue.push(chunk.slice()); notify() },
    close: () => { closed = true; notify() },
    abort: () => { closed = true; notify() }
  })
  return { readable, writable }
}

class StdinSource {
  private pending = ''
  private eof = false
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  constructor(private readonly stream: ReadableStream<Uint8Array>) {}

  /** A read that a timeout abandoned: kept, so the chunk it eventually gets is not lost. */
  private inflight: Promise<ReadableStreamReadResult<Uint8Array>> | undefined

  /** Appends one chunk to the buffer. False at end of stream or when `timeoutMs` ran out (`timedOut` is set). */
  private async fill(timeoutMs?: number): Promise<boolean> {
    if (this.eof) return false
    this.reader ??= this.stream.getReader()
    this.inflight ??= this.reader.read()
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = timeoutMs === undefined
      ? await this.inflight
      : await Promise.race([this.inflight, new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })])
    clearTimeout(timer)
    if (outcome === 'timeout') { this.timedOut = true; return false }
    this.inflight = undefined
    if (outcome.done) { this.eof = true; return false }
    this.pending += new TextDecoder().decode(outcome.value)
    return true
  }

  private timedOut = false

  /**
   * The next line without its newline, or `undefined` at EOF. `delimiter` replaces the newline, `count` stops after
   * that many characters, `result.terminated` says whether one ended the read.
   */
  async readLine(options: { delimiter?: string, count?: number, timeoutMs?: number, result?: { terminated: boolean, timedOut?: boolean } } = {}): Promise<string | undefined> {
    const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs
    this.timedOut = false
    const delimiter = options.delimiter === undefined ? '\n' : options.delimiter === '' ? '\0' : options.delimiter
    for (;;) {
      const found = this.pending.indexOf(delimiter)
      const available = found === -1 ? this.pending.length : found
      if (options.count !== undefined && available >= options.count) {
        const line = this.pending.slice(0, options.count)
        this.pending = this.pending.slice(options.count)
        if (options.result) options.result.terminated = true
        return line
      }
      if (found !== -1) {
        const line = this.pending.slice(0, found)
        this.pending = this.pending.slice(found + 1)
        if (options.result) options.result.terminated = true
        return line
      }
      if (!await this.fill(deadline === undefined ? undefined : Math.max(0, deadline - Date.now()))) {
        // A final line with no trailing newline is still a line; an empty tail is EOF.
        if (options.result) { options.result.terminated = false; options.result.timedOut = this.timedOut }
        if (this.pending === '') return undefined
        const line = this.pending
        this.pending = ''
        return line
      }
    }
  }

  /**
   * The buffered data, or the next chunk when none is buffered; what a real command gets as stdin. Unread bytes come
   * back through `unread`.
   */
  chunks(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        if (this.pending === '') await this.fill()
        if (this.pending === '') return controller.close()
        controller.enqueue(new TextEncoder().encode(this.pending))
        this.pending = ''
      }
    }, { highWaterMark: 0 })
  }

  /** Puts bytes a command did not consume back at the front. */
  unread(bytes: Uint8Array): void {
    this.pending = new TextDecoder().decode(bytes) + this.pending
  }

  async readAll(): Promise<string> {
    while (await this.fill()) { /* drain */ }
    const text = this.pending
    this.pending = ''
    return text
  }

  async close(): Promise<void> {
    try { await this.reader?.cancel() } catch { this.reader?.releaseLock() }
  }
}


/** A tracked pipeline job; see `Job` in `@ecmaos/types`. Resolves `done` once every stage settles. */
class JobImpl implements Job {
  notified?: boolean
  id: number
  commandLine: string
  status: JobStatus = 'running'
  exitCodes?: number[]
  processes: JobProcessHandle[] = []
  background: boolean
  /** Assigned by `Shell.createJob` once `runPipeline` has started. */
  done!: Promise<number[]>

  constructor(id: number, commandLine: string, background: boolean) {
    this.id = id
    this.commandLine = commandLine
    this.background = background
  }
}

/** The signals the terminal's line discipline raises for `^C`, `^\\` and `^Z`. */
const TerminalSignals: ReadonlySet<number> = new Set([Signal.INT, Signal.QUIT, Signal.TSTP])

const DefaultShellPath = '$HOME/bin:/bin:/usr/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin'
/** A command name that resolved to nothing. Fails that command with exit 127 and lets the script continue. */
/** What the shell itself puts before a diagnostic, as `ecmash` does with its own name: `<name>: <message>`. */
const DIAGNOSTIC_PREFIX = 'ecmaos: '

/** What bash says for a line the parser rejects: an open quote is an unexpected EOF, anything else a syntax error. */
function syntaxMessage(message: string): string {
  const open = /^Unterminated (single|double) quote$/.exec(message)
  if (open) return `unexpected EOF while looking for matching \`${open[1] === 'single' ? "'" : '"'}'`
  if (message === 'Unterminated backquote') return "unexpected EOF while looking for matching ``'"
  if (message.startsWith('syntax error')) return message
  return `syntax error: ${message}`
}

/** What a statement-tree parse failure says: bash's words for input that ends inside a command, or the parser's own */
function controlFlowMessage(error: ControlFlowParseError): string {
  return error.incomplete ? 'syntax error: unexpected end of file' : syntaxMessage(error.message)
}

class CommandNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'CommandNotFoundError' }
}

const DefaultShellOptions = {
  cwd: '/',
  env: {
    PATH: DefaultShellPath,
    SHELL: 'ecmaos',
    TERM: 'xterm.js',
    USER: 'root',
    HOME: '/root',
  }
}

/**
  * @experimental
  * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
  * 
  * The Shell class handles the Terminal environment and interaction with the Kernel.
  * 
 */
export class Shell implements IShell {
  private _createPipeStream: ShellCreatePipeStream
  private _adoptProcess?: (process: object) => void
  private _ctx: KernelContext
  private _cwd: string
  private _execute: ShellExecute
  private _filesystem: Filesystem
  private _id: string = crypto.randomUUID()
  private _terminal: ITerminal
  private _terminalWriter?: WritableStreamDefaultWriter<Uint8Array>
  private _tty: number
  private _users: Users

  /** `local` overlays, one per function call; empty outside a function. */
  /**
   * Inputs opened by a redirected compound statement (`while ...; done < f`), innermost last. `read` and a first-
   * stage command read from the top when they have no redirection of their own.
   */
  private _stdinSources: StdinSource[] = []
  /**
   * Active aggregate builtins (`eval`, `source`, ...) feeding a pipe, as factories for non-closing views of that
   * pipe.
   */
  private _heldStdout: Array<() => WritableStream<Uint8Array>> = []
  /** For each `_heldStdout` entry, how many statement redirections were in force when it was pushed. */
  private _heldFloor: number[] = []

  /**
   * Output redirections of enclosing aggregate commands (`done > f`, a redirected function call, `eval`/`source`),
   * outermost first. `truncated` records which fds were already truncated so `> f` truncates once.
   */
  /** Numbered inputs `exec N<file` opened on this shell, read by `read -u N`. */
  private _inputFds = new Map<number, StdinSource>()
  private _statementOutputs: Array<{ redirections: Redirection[], truncated: Set<number> }> = []

  /** Output redirections installed by `exec > file`; the outermost layer for `inheritedOutputRedirections`. */
  /** `after` is how many block redirections were in force when `exec` installed these: later ones override, earlier ones are overridden. */
  private _execOutputs?: { redirections: Redirection[], truncated: Set<number>, after: number }

  /** The jobs this shell still has something to say about, oldest first: one that has finished and been reported is dropped when the next job starts, except the latest. */
  private _jobs: JobImpl[] = []
  /** The job in the foreground, if any. Single-foreground model; there are no process groups. */
  /** The startup file being sourced, so a diagnostic can name it. */
  private _sourceFile: string | undefined
  private _foregroundJob: Job | undefined

  /**
   * Set when a foreground process was killed by `SIGINT`, so the rest of a `;`/`&&`/`||` list and any enclosing loop
   * stop. Cleared at the start of each outermost `execute()`.
   */
  private _interrupted = false
  private _interruptClaimed = false

  /** How many `execute()` calls are on the stack; only the outermost clears `_interrupted`. */
  /** Called when `exit` runs at the prompt, so a login session ends instead of only setting `$?`. */
  onExit?: (code: number) => void

  private _executeDepth = 0

  /**
   * How many frames on the stack will catch each control-flow signal (`exit`, `return`, `break`/`continue`); see
   * `shell-core/signals`.
   */
  private get _signalCatchers() { return this.interpreter.catchers }

  /**
   * A registered `@zenfs/linux` `Process` standing for this shell, created on first use; source of `$$` and `$PPID`.
   * Its descriptors go to `/dev/null`.
   */
  private _process?: InstanceType<typeof ZenFSProcess>

  /**
   * The language state shared with `/bin/ecmash`: variables, arrays, `local` frames, `readonly`, functions, aliases,
   * traps and options. The underscore names below are views onto it.
   */
  readonly state = new ShellState({
    pid: () => this.process.pid,
    ppid: () => this.process.ppid,
    groups: () => [String(this.credentials.gid), ...this.credentials.groups.filter(group => group !== this.credentials.gid).map(String)]
  })

  /** The shared statement walk. This shell supplies how a pipeline runs (see {@link hostInterface}). */
  readonly interpreter = new Interpreter(this.hostInterface(), this.state)
  private get _env(): Map<string, string> { return this.state.vars }
  private set _env(vars: Map<string, string>) { this.state.adopt(vars) }
  private get _functions() { return this.state.functions }
  private set _functions(functions: Map<string, Statement[]>) { this.state.functions = functions }
  private get _aliases() { return this.state.aliases }
  private get _shellOptions() { return this.state.options }
  private get _arrays() { return this.state.arrays }
  private set _arrays(arrays: Map<string, Map<number | string, string>>) { this.state.arrays = arrays }
  private _lastBackgroundJob: JobImpl | undefined
  private get _lastBackgroundPid() { return this.state.lastBackgroundPid }
  private set _lastBackgroundPid(pid: number | undefined) { this.state.lastBackgroundPid = pid }

  public readonly config: TerminalConfig

  public credentials: Credentials = { uid: 0, gid: 0, suid: 0, sgid: 0, euid: 0, egid: 0, groups: [] }
  private _context: BoundContext = bindContext({ root: '/', pwd: '/', credentials: this.credentials })
  private _umask = DEFAULT_UMASK

  get context(): BoundContext { return this._context }
  /**
   * A new context starts with this shell's file creation mask, so a login or `su` that rebinds it does not lose
   * `umask`.
   */
  set context(value: BoundContext) {
    this._context = value
    const umasked = value as { umask?: number }
    if (typeof umasked.umask === 'number') umasked.umask = this._umask
  }

  /**
   * The file mode creation mask. The programs this shell starts take it, and so do the files it creates for a
   * redirection; a file system with a mask of its own is given the same one.
   */
  get umask(): number { return this._umask }
  set umask(mask: number) {
    this._umask = mask & 0o777
    const umasked = this._context as { umask?: number }
    if (typeof umasked.umask === 'number') umasked.umask = this._umask
  }

  get cwd() { return this._cwd }
  /** Setting the working directory also sets `PWD` and `OLDPWD`. */
  set cwd(path: string) {
    const normalized = path === '/' ? path : path.endsWith('/') ? path.slice(0, -1) : path
    const previous = this._cwd
    this._cwd = normalized
    if (previous !== undefined && previous !== normalized) this._env.set('OLDPWD', previous)
    this._env.set('PWD', normalized)
  }
  get env() { return this.state.vars }
  set env(env: Map<string, string>) { this.state.adopt(env); this.publishEnv() }
  /**
   * This shell's environment as a plain object: the `envp` of every child. Shell-internal names (see
   * `SHELL_ONLY_VARIABLES`) are left out.
   */
  get envObject() {
    return this.state.environment()
  }

  /**
   * Publishes the exported environment to `globalThis.process.env` if this shell owns that mirror; a no-op otherwise.
   */
  publishEnv(): void {
    if (processEnvOwner !== this) return
    globalThis.process.env = this.envObject
  }

  /** Makes this shell the one `globalThis.process.env` mirrors. Called when its TTY becomes active. */
  claimProcessEnv(): void {
    processEnvOwner = this
    globalThis.process.env = this.envObject
  }
  get id() { return this._id }
  get terminal() { return this._terminal }
  get username() { return this._users.get(this.credentials.uid)?.username || 'root' }
  get tty() { return this._tty }
  get shellOptions() { return this._shellOptions }
  get functions() { return this._functions }
  /** `alias`/`unalias`'s table. See {@link _aliases}. */
  get aliases() { return this._aliases }
  get foregroundJob() { return this._foregroundJob }

  /** Whether the line currently running was interrupted by `^C`. */
  get interrupted() { return this._interrupted }

  /**
   * Records that a foreground process was interrupted and runs any `INT` trap. `Kernel.executeViaExecve` calls it
   * when the process was killed by `SIGINT`, since `Terminal.keyHandler` does not see `^C` while the line discipline
   * owns the keyboard.
   */
  /**
   * True for the first caller after an interrupt, false for the rest, so an interrupted pipeline reports once rather
   * than once per stage. Cleared when the next command starts.
   */
  claimInterrupt(): boolean {
    if (this._interruptClaimed) return false
    this._interruptClaimed = true
    return true
  }

  async notifyInterrupted(): Promise<void> {
    // Handler first, flag second. The handler runs through `execute()` like any other command, so
    // if the flag were already set, a multi-command handler (`trap 'echo a; echo b' INT`) would
    // abort after its first stage on the very check this flag exists to drive.
    await this.runTrap('INT')
    this._interrupted = true
  }
  /** The real user registry. */
  get users() { return this._users }

  /**
   * Files this console's login in `/run/utmp` and `/var/log/wtmp`. A failure to record is never a failure to log in.
   */
  async recordLogin(username: string): Promise<void> {
    try {
      this._sessions ??= new SessionLog(this._filesystem.fs)
      await this._sessions.login(username, this._tty)
    } catch { /* the login itself already succeeded */ }
  }
  async recordLogout(): Promise<void> {
    try {
      this._sessions ??= new SessionLog(this._filesystem.fs)
      await this._sessions.logout(this._tty)
    } catch { /* nothing to undo */ }
  }
  private _sessions?: SessionLog
  /** Translated strings, for the messages the shell itself prints. */
  get i18n() { return this._ctx.i18n }

  /** Resolves a variable: the innermost `local` frame first, then the environment. */
  lookupVariable(name: string): string | undefined {
    return this.state.lookup(name)
  }

  /** `getopts`'s position within the argument it is currently reading. See {@link _getoptsCharIndex}. */
  get getoptsCharIndex(): number { return this.state.getoptsCharIndex }
  set getoptsCharIndex(index: number) { this.state.getoptsCharIndex = index }

  /**
   * This shell's own process; see `_process`. Created lazily because `/dev` is not mounted when the shell is
   * constructed.
   */
  get process(): InstanceType<typeof ZenFSProcess> {
    if (!this._process) {
      this._process = new ZenFSProcess({ argv: ['ecmash'], cwd: this._cwd, console: '/dev/null' })
      this._adoptProcess?.(this._process)
    }
    return this._process
  }

  /** Whether `name` was marked `readonly`, so an assignment or an unset must be refused. */
  isReadonly(name: string): boolean { return this.state.isReadonly(name) }

  /** Marks `name` readonly. There is deliberately no way back, as in bash. */
  markReadonly(name: string): void { this.state.markReadonly(name) }

  /** Every readonly name, for `readonly -p`. */
  readonlyNames(): string[] { return [...this.state.readonlyNames].sort() }

  /**
   * Sets a variable in the innermost `local` frame if one is active, else in the environment.
   * @throws when `name` is `readonly`
   */
  setVariable(name: string, value: string, append = false): void {
    this.state.set(name, value, append)
    this.publishEnv()
  }

  /**
   * Every variable visible now, `local` frames over the environment, without shell-internal names. What `export -p`
   * and bare `env` list.
   */
  visibleVariables(): Map<string, string> {
    return this.state.visibleVariables()
  }

  /**
   * Indexed arrays, with mutators for `=(...)`, `a[i]=`, `unset a[i]` and `a+=(...)`. A name declared `local` is read
   * and written in its frame.
   */
  get arrays(): Map<string, Map<number | string, string>> {
    return this.state.visibleArrays()
  }

  /** Reads `name`'s array from the innermost frame that declares it, else from the shell's own. */
  lookupArray(name: string): Map<number | string, string> | undefined {
    return this.state.lookupArray(name)
  }

  setArray(name: string, values: string[]): void { this.state.setArray(name, values) }
  setArrayElement(name: string, index: number, value: string): void { this.state.setArrayElement(name, index, value) }
  appendArray(name: string, values: string[]): void { this.state.appendArray(name, values) }
  unsetArrayElement(name: string, index: number): void { this.state.unsetArrayElement(name, index) }
  unsetArray(name: string): void { this.state.unsetArray(name) }

  /** Sets, clears or ignores a trap. Names are normalized (`SIGINT` and `INT` are the same). */
  setTrap(handler: string | undefined, signal: string): void { this.state.setTrap(handler, signal) }

  /** Whether `pid` is this shell's own process, the one `$$` names. */
  ownsPid(pid: number): boolean { return this._process?.pid === pid }

  /** Delivers a signal sent to this shell with `kill`: runs the trap for it, if any. False when there is no trap. */
  async deliverSignal(signal: number): Promise<boolean> {
    const name = signalNameOf(signal)
    // `trap '' SIG` ignores the signal: it is consumed here too, so it never reaches the process behind the shell
    if (!name || this.state.getTrap(name) === undefined) return false
    await this.runTrap(name)
    return true
  }
  getTrap(signal: string): string | undefined { return this.state.getTrap(signal) }
  listTraps(): Array<[string, string]> { return this.state.listTraps() }

  /**
   * Runs the handler registered for `signal`, if any (and it isn't the `''` ignore marker). Errors from the handler
   * are swallowed - a bad trap must not crash the shell.
   */
  async runTrap(signal: string): Promise<void> {
    const handler = this.getTrap(signal)
    if (!handler) return
    try { await this.execute(handler) } catch { /* a failing trap handler does not stop the shell */ }
  }

  /** Builds the `ExpansionContext` bound to this shell's variables, arrays and positional parameters. */
  expansionContext(): ExpansionContext {
    return {
      lookup: (name) => this.lookupVariable(name),
      lookupArray: (name) => this.lookupArray(name),
      isAssoc: (name) => this.state.isAssoc(name),
      positional: () => {
        const positional: string[] = []
        for (let i = 1; ; i++) {
          const value = this.lookupVariable(String(i))
          if (value === undefined) break
          positional.push(value)
        }
        return positional
      },
      assign: (name, value) => this.setVariable(name, value),
      substitute: (command) => this.executeCommandSubstitution(command),
      processSubstitute: (direction, command) => this.processSubstitute(direction, command),
      glob: (pattern) => this.expandGlob(pattern),
      home: () => this._env.get('HOME'),
      userHome: name => [...this._users.all.values()].find(user => user.username === name)?.home,
      nounset: this._shellOptions.nounset,
      shopt: (name) => this.state.shopts.has(name)
    }
  }

  /** Declare `name` as local to the current function call, defaulting to '' until assigned. */
  declareLocal(name: string, value?: string): void { this.state.declareLocal(name, value) }

  /** Apply a `set` flag. See {@link _shellOptions} for what each one does. */
  applyShellOption(flag: ShellOptionName, enabled: boolean): void { this.state.setOption(flag, enabled) }

  /** `set -x`: writes `$PS4` and the expanded arguments to stderr. */
  private async trace(args: readonly string[]): Promise<void> {
    if (!this._shellOptions.xtrace || args.length === 0) return
    const ps4 = this.lookupVariable('PS4') ?? '+ '
    await this.shellDiagnostic(ps4 + args.join(' '), true)
  }

  /** `set -v` - echoes a line of input to stderr before it runs. */
  private async traceVerbose(line: string): Promise<void> {
    if (!this._shellOptions.verbose || !line) return
    await this.shellDiagnostic(line, true)
  }

  constructor(_options: ShellOptions & { tty?: number }) {
    const options = { ...DefaultShellOptions, ..._options }
    globalThis.shells?.set(this.id, this)

    this._tty = options.tty ?? 0
    this._cwd = options.cwd || DefaultShellOptions.cwd
    this._env = new Map([...Object.entries(DefaultShellOptions.env), ...Object.entries(options.env)])
    this._ctx = options.context
    this._createPipeStream = options.createPipeStream
    this._execute = options.execute
    this._adoptProcess = options.adoptProcess
    this._filesystem = options.filesystem
    this._users = options.users
    this._terminal = options.terminal as ITerminal
    this._terminalWriter = this._terminal?.stdout.getWriter() || new WritableStream().getWriter()
    this.config = new TerminalConfig(this)

    // `_cwd` was assigned directly above, before `_env` existed, so the `cwd` setter that normally
    // maintains `PWD` never ran for the initial value. Seed it here so `$PWD` is correct from the
    // first prompt rather than only after the first `cd`.
    this._env.set('PWD', this._cwd)

    // `$SHLVL` is an environment entry, so a child shell inherits it and adds one.
    const inherited = Number(this._env.get('SHLVL'))
    this._env.set('SHLVL', String(Number.isFinite(inherited) && inherited > 0 ? inherited + 1 : 1))
  }

  /**
   * Loads environment variables from /etc/env and ~/.env
   */
  async loadEnvFile() {
    // Load global /etc/env first
    try {
      if (await this.context.fs.promises.exists('/etc/env')) {
        const globalContent = await this.context.fs.promises.readFile('/etc/env', 'utf-8')
        const globalEnvVars = this.parseEnvFile(globalContent)
        for (const [key, value] of Object.entries(globalEnvVars)) {
          this._env.set(key, value)
        }
      }
    } catch { /* a missing or unreadable file leaves the environment as is */ }

    // Load user ~/.env second (overwrites global values)
    const home = this._env.get('HOME')
    if (!home) return

    const envFilePath = path.join(home, '.env')
    try {
      if (!await this.context.fs.promises.exists(envFilePath)) return

      const content = await this.context.fs.promises.readFile(envFilePath, 'utf-8')
      const envVars = this.parseEnvFile(content)
      for (const [key, value] of Object.entries(envVars)) {
        this._env.set(key, value)
      }

      this.publishEnv()
    } catch { /* the process mirror is optional */ }
  }

  /**
   * Runs the startup files in the order given by `shell-core/startup-files`. Does not fire the `EXIT` trap, and a
   * file that fails does not stop the others.
   */
  async loadProfile() {
    const fs = this.context.fs.promises
    const candidates = await startupFiles(
      { home: this._env.get('HOME'), login: true, interactive: true },
      {
        isFile: async file => { try { return (await fs.stat(file)).isFile() } catch { return false } },
        list: async dir => { try { return await fs.readdir(dir) } catch { return [] } }
      }
    )

    for (const file of candidates) {
      try {
        const content = await this.context.fs.promises.readFile(file, 'utf-8')
        this._sourceFile = file
        await this.executeSourced(content, undefined, file)
      } catch (error) {
        // `exit` in a startup file stops startup, as in bash - there is no process to end here, so
        // the remaining files are skipped and the prompt is reached anyway.
        if (error instanceof ExitSignal) break
        try {
          this.terminal?.writeln(`ecmash: ${file}: ${(error as Error).message}`)
        } catch { /* no terminal to report to */ }
      } finally {
        this._sourceFile = undefined
      }
    }

    this.publishEnv()
  }

  /**
   * Loads terminal configuration from config files and applies to terminal
   */
  async loadConfig() {
    await this.config.load()
    this.terminal.updateConfig()
  }

  /**
   * Parses environment variables from a string
   */
  parseEnvFile(content: string): Record<string, string> {
    const envVars: Record<string, string> = {}
    const lines = content.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      
      if (!trimmed || trimmed.startsWith('#')) continue

      const match = trimmed.match(/^([^=#\s]+)=(.*)$/)
      if (match) {
        const [, key, value] = match
        // `value` is `''` for a bare `FOO=`, an assignment of the empty string; only a missing key is skipped.
        if (!key) continue
        let parsedValue = (value ?? '').trim()

        if ((parsedValue.startsWith('"') && parsedValue.endsWith('"')) ||
            (parsedValue.startsWith("'") && parsedValue.endsWith("'")))
          parsedValue = parsedValue.slice(1, -1)

        envVars[key] = parsedValue
      }
    }

    return envVars
  }
  
  /**
   * Attaches a terminal to the shell
   */
  attach(terminal: ITerminal) {
    if (this._terminalWriter) {
      try { this._terminalWriter.releaseLock() } catch { /* the lock may already be released */ }
    }
    
    this._terminal = terminal
    this._terminalWriter = terminal.stdout.getWriter()
  }

  /**
   * Clears positional parameters
   */
  clearPositionalParameters() {
    for (const key of this.env.keys()) {
      if (!isNaN(parseInt(key))) this.env.delete(key)
    }
  }

  /**
   * `$(...)`: runs `command` in a subshell with stdout held on a scratch file and returns the output; the status is
   * kept for `x=$(cmd)`.
   */
  private async executeCommandSubstitution(command: string): Promise<string> {
    const fs = this.context.fs.promises
    const path = `/tmp/.subst-${this._id.slice(0, 8)}-${this._substitutionCount++}`
    await fs.writeFile(path, new Uint8Array())
    const redirection: Redirection = { type: '>', fd: 1, target: path, targetParts: [{ text: path, quoting: 'single' }] }
    try {
      const status = await this.withStatementRedirections([redirection], () => this.interpreter.runSubshell(parseStatements(command)))
      this._substitutionStatus = status
      const text = await fs.readFile(path, 'utf-8')
      return text.replace(/\n+$/, '')
    } catch (error) {
      if (error instanceof ExitSignal) { this._substitutionStatus = error.code; return '' }
      throw error
    } finally {
      await fs.unlink(path).catch(() => {})
    }
  }

  private _substitutionCount = 0
  /** The status of the last `$(...)` run while expanding the current command; read by an assignment-only command. */
  private _substitutionStatus: number | undefined

  /** Expands `~`, `~/` and `~/path` to the user's home, outside single quotes. */
  expandTilde(input: string): string {
    const home = this._env.get('HOME')
    if (!home) return input

    let result = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let escaped = false
    let i = 0

    while (i < input.length) {
      const char = input[i]
      const nextChar = input[i + 1]

      if (escaped) {
        result += char
        escaped = false
        i++
        continue
      }

      if (char === '\\') {
        escaped = true
        result += char
        i++
        continue
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        result += char
        i++
        continue
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        result += char
        i++
        continue
      }

      // Only expand tilde outside single quotes
      // Tilde can be expanded inside double quotes (standard shell behavior)
      if (!inSingleQuote && char === '~') {
        // Check if this is a word boundary (start of string, after whitespace, or after =)
        const isWordStart = i === 0 || (i > 0 && /\s|=/.test(input[i - 1] ?? ' '))
        
        if (isWordStart) {
          // Check if it's ~/path or just ~
          if (nextChar === '/' || nextChar === undefined || /\s/.test(nextChar)) {
            result += home
            i++
            continue
          }
        }
      }

      result += char
      i++
    }

    return result
  }

  /** Expands a glob pattern to matching file paths. */
  /** What `shopt` has changed about how a pattern matches. */
  private get patternOptions(): GlobOptions {
    const on = (name: string) => this.state.shopts.has(name)
    return { extglob: on('extglob'), dotglob: on('dotglob'), globstar: on('globstar'), nocase: on('nocaseglob') }
  }

  private async expandGlob(pattern: string): Promise<string[]> {
    // `set -f`: pathname expansion off, so the pattern stays exactly as written.
    if (this._shellOptions.noglob) return []
    const options = this.patternOptions
    if (!hasGlobCharacters(pattern, options)) return []
    const fs = this.context.fs.promises
    const absolute = (p: string) => p.startsWith('/') ? p : path.resolve(this.cwd, p)
    return await globPaths(pattern, {
      readdir: dir => fs.readdir(absolute(dir)),
      isDirectory: async path => { try { return (await fs.stat(absolute(path))).isDirectory() } catch { return false } },
      exists: path => fs.exists(absolute(path)),
    }, options)
  }

  /**
   * Builds the fd -> stream map for one command, applying its redirections left to right. Unredirected fds 1 and 2 go
   * to the terminal, or the pipe mid-pipeline.
   */
  private async buildOutputStreams(
    redirections: Redirection[],
    isLastCommand: boolean,
    pipeWritable: WritableStream<Uint8Array> | undefined
  ): Promise<{ stdout: WritableStream<Uint8Array>, stderr: WritableStream<Uint8Array> }> {
    const fdStreams = new Map<number, WritableStream<Uint8Array>>()
    const fdFiles = new Map<number, { path: string, append: boolean, device?: boolean }>()


    const defaultFor = (fd: number): WritableStream<Uint8Array> => {
      const existing = fdStreams.get(fd)
      if (existing) return existing
      const held = this._heldStdout[this._heldStdout.length - 1]
      const created = fd === 1
        ? (isLastCommand ? (held ? held() : this.createTerminalOutputStream()) : (pipeWritable as WritableStream<Uint8Array>))
        : this.createTerminalErrorStream()
      fdStreams.set(fd, created)
      return created
    }

    for (const redirection of redirections) {
      if (redirection.type === '>&') {
        if (redirection.targetIsFd) {
          const sourceFd = Number(redirection.target)
          // Resolve what the source fd points to right now, so `2>&1 > f` and `> f 2>&1` differ
          const sourceFile = fdFiles.get(sourceFd)
          if (sourceFile) {
            fdStreams.set(redirection.fd, this.createFileWriteStream(sourceFile.path, sourceFile.append, sourceFile.device))
            fdFiles.set(redirection.fd, sourceFile)
          } else {
            fdStreams.set(redirection.fd, defaultFor(sourceFd))
            fdFiles.delete(redirection.fd)
          }
        }
        continue
      }

      if (redirection.type === '>' || redirection.type === '>>' || redirection.type === '>|') {
        // The target is expanded (`> /tmp/work.$$`).
        const targetPath = path.resolve(this.cwd, await this.expandRedirectionTarget(redirection))
        const append = redirection.type === '>>'
        // Whether the target is a character device is found out here, not in the stream, so that a regular file is opened and
        // truncated as soon as its stream is made (two streams on one file, `> f 2>&1`, depend on that order)
        const device = await this.isCharacterDevice(targetPath)
        fdStreams.set(redirection.fd, this.createFileWriteStream(targetPath, append, device))
        fdFiles.set(redirection.fd, { path: targetPath, append, device })
      }
    }

    // Two fds that both resolved to the same underlying file need one shared, serialized writer,
    // not two independent ones racing each other - this is what &> and 2>&1 > f actually need.
    const stdoutFile = fdFiles.get(1)
    const stderrFile = fdFiles.get(2)
    if (stdoutFile && stderrFile && stdoutFile.path === stderrFile.path) {
      const shared = this.createSharedFileStreams(stdoutFile.path, stdoutFile.append || stderrFile.append)
      fdStreams.set(1, shared.stdout)
      fdStreams.set(2, shared.stderr)
    }

    return {
      stdout: defaultFor(1),
      stderr: defaultFor(2)
    }
  }

  /**
   * Resolves one stage's words (substitution, history, tilde, variables, arithmetic, glob) into a runnable command.
   * Single-quoted words are not expanded.
   */
  private async prepareCommand(command: ParsedCommand): Promise<{ finalCommand: string, args: string[], typed?: string }> {
    const ctx = this.expansionContext()
    const fields: string[] = []
    for (const [index, word] of command.words.entries()) {
      const parts = command.wordParts[index]
      if (this._shellOptions.nounset) this.assertNoUnsetReferences(word)
      fields.push(...await this.expandFields(parts?.length ? parts : [{ text: word, quoting: 'unquoted' }], ctx))
    }

    const [commandName, ...args] = fields
    if (!commandName) {
      throw new CommandNotFoundError(this._ctx.i18n.t('commandNotFound', { ns: 'kernel', command: command.words.join(' ') }))
    }

    // `kill %1`: a job spec names the processes of one of this shell's jobs, which only the shell knows.
    if (commandName === 'kill') {
      for (let i = 0; i < args.length; i++) {
        if (!args[i]?.startsWith('%')) continue
        const pids = this.getJob(args[i])?.processes.map(process => String(process.pid)) ?? []
        if (pids.length > 0) args.splice(i, 1, ...pids)
      }
    }

    const finalCommand = await this.resolveCommand(commandName)
    if (!finalCommand) {
      throw new CommandNotFoundError(this._ctx.i18n.t('commandNotFound', { ns: 'kernel', command: commandName }))
    }

    return { finalCommand, args, typed: commandName }
  }

  /**
   * `set -u`: throws if `original` references a plain `$VAR` or `${VAR}` that is unset. `${VAR:-x}` forms are exempt.
   */
  private assertNoUnsetReferences(original: string): void {
    const pattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(original))) {
      const name = match[1] ?? match[2]
      if (name && this.lookupVariable(name) === undefined) {
        throw new UnboundVariableError(`${name}: unbound variable`)
      }
    }
  }

  /**
   * Runs one pipeline, wiring each stage's stdout to the next stage's stdin. Returns each stage's exit code in order.
   * @param job - when given, each stage's process is added to `job.processes` as it starts, so signals reach it.
   */
  private async runPipeline(pipeline: Pipeline, job?: JobImpl): Promise<number[]> {
    // Process substitutions expanded for this pipeline's words live until it has finished.
    const mark = this._processSubstitutions.length
    try {
      return await this.runPipelineWithPrefixes(pipeline, job)
    } catch (error) {
      // A write that the target refuses (`echo hi > /dev/full`) fails that pipeline with status 1 and the list goes on, as in
      // bash; anything else, control-flow signals included, is not this method's to swallow
      const code = (error as { code?: unknown }).code
      if (!(error instanceof Error) || typeof code !== 'string' || !/^E[A-Z0-9]+$/.test(code)) throw error
      await this.shellDiagnostic(error.message)
      return pipeline.commands.map(() => 1)
    } finally {
      await this.finishProcessSubstitutions(mark)
    }
  }

  /**
   * `<(cmd)` and `>(cmd)`: a temp file in `/tmp` standing in for the far end of a pipe, removed when the pipeline
   * finishes. Not streaming: `<(cmd)` runs to completion first, `>(cmd)` runs after the writer finishes.
   */
  private async processSubstitute(direction: '<' | '>', command: string): Promise<string> {
    const fs = this.context.fs.promises
    const path = `/tmp/.procsub-${this._id.slice(0, 8)}-${this._processSubstitutionCount++}`
    await fs.writeFile(path, new Uint8Array())
    const redirection: Redirection = {
      type: '>',
      fd: 1,
      target: path,
      targetParts: [{ text: path, quoting: 'single' }]
    }
    // `>(cmd)` needs the file as cmd's stdin, so the redirection is written into the line on the first command that
    // reads (`< file a | b`); compound commands and lists fall back to the held redirection.
    const firstWord = command.trim().split(/\s+/)[0] ?? ''
    const simple = !CONTROL_FLOW_KEYWORDS.has(firstWord) && !/[;\n]|&&|\|\|/.test(command)
    const run = async () => {
      try {
        if (direction === '>' && simple) await this.executeStatements(parseStatements(`< '${path}' ${command}`))
        else await this.withStatementRedirections([redirection], () => this.executeStatements(parseStatements(command)))
      } catch (error) {
        // `exit` inside the substitution ends only the substitution.
        if (!(error instanceof ExitSignal)) throw error
      }
    }

    if (direction === '<') await run()
    this._processSubstitutions.push({ path, after: direction === '>' ? run : undefined })
    return path
  }

  private async finishProcessSubstitutions(mark: number): Promise<void> {
    const finished = this._processSubstitutions.splice(mark)
    for (const { path, after } of finished) {
      try { await after?.() } finally {
        await this.context.fs.promises.unlink(path).catch(() => {})
      }
    }
  }

  private _processSubstitutions: Array<{ path: string, after?: () => Promise<void> }> = []
  private _processSubstitutionCount = 0

  private async runPipelineWithPrefixes(pipeline: Pipeline, job?: JobImpl): Promise<number[]> {
    const prefixes: Assignment[] = []
    const commands = pipeline.commands.map(command => {
      const split = splitAssignments(command)
      prefixes.push(...split.assignments)
      return split.command
    })
    if (prefixes.length === 0) return await this.runPipelineStages(pipeline, commands, job)

    const restore = await this.applyAssignmentPrefixes(prefixes)
    try {
      return await this.runPipelineStages(pipeline, commands, job)
    } finally {
      restore()
    }
  }

  /**
   * Applies a pipeline's `NAME=VALUE` prefixes, left to right and before the words are expanded, and returns a
   * function that restores the previous values. Applied around the whole pipeline, so per-stage prefixes are
   * approximate.
   */
  private async applyAssignmentPrefixes(entries: Assignment[]): Promise<() => void> {
    const saved = entries.map(({ name }) => ({ name, had: this.env.has(name), previous: this.env.get(name), unexported: this.state.unexported.has(name) }))
    for (const { name, append, parts } of entries) {
      const value = await expandWordString(parts, this.expansionContext())
      this.env.set(name, append ? (this.env.get(name) ?? '') + value : value)
      // A prefix assignment is part of the environment of that one command, whatever the variable was before.
      this.state.markExported(name)
    }
    return () => {
      for (const { name, had, previous, unexported } of saved) {
        if (had) this.env.set(name, previous as string)
        else this.env.delete(name)
        if (unexported) this.state.unexported.add(name)
      }
    }
  }

  private async runPipelineStages(pipeline: Pipeline, commands: readonly ParsedCommand[], job?: JobImpl): Promise<number[]> {
    /** A stage: a command for `Kernel.execute`, or a builtin run in this shell's tick, wired with the same fds. */
    type Stage = {
      args: string[]
      stdin: ReadableStream<Uint8Array> | undefined
      /** A file or device that is the program's real stdin (`cmd < file`); see `KernelExecuteOptions.stdinFile` */
      stdinFile: string | undefined
      openStdin: (() => ReadableStream<Uint8Array>) | undefined
      /** Set when the stage's stdin is a compound statement's shared input; a builtin reads it directly. */
      stdinSource: StdinSource | undefined
      stdinLeftover: ((bytes: Uint8Array) => void) | undefined
      stdinIsTTY: boolean
      stdout: WritableStream<Uint8Array>
      stdoutIsTTY: boolean
      /**
       * Whether stdout has a final destination (file or terminal), so the kernel drains it before reporting the exit
       * code. Only the last stage qualifies.
       */
      drainStdout: boolean
      stderr: WritableStream<Uint8Array>
      /**
       * The pipe this stage reads from, told when the stage is done so a writer still sending to it fails instead of
       * waiting
       */
      inputPipe?: { abandon?: () => void }
    } & ({ kind: 'command', finalCommand: string, typed?: string } | { kind: 'builtin', name: string, aggregate: readonly Redirection[] | undefined } | { kind: 'compound', run: () => Promise<number> })

    const stages: Stage[] = []

    // Compound stages run one after another in pipeline order over buffered pipes, because the per-shell stacks they
    // use would interleave.
    const inProcessCount = commands.filter(c => c.compound || (commands.length > 1 && !trueBuiltinNameFor(c.words[0]) && this._functions.has(c.words[0] ?? ''))).length
    const buffered = inProcessCount >= 2
    let compoundTurn: Promise<unknown> = Promise.resolve()

    let prevReadable: ReadableStream<Uint8Array> | undefined
    let prevPipe: { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, abandon?: () => void } | undefined

    for (let i = 0; i < commands.length; i++) {
      const command = commands[i] as ParsedCommand
      const isFirstCommand = i === 0
      const isLastCommand = i === commands.length - 1

      // Builtins keep their own quote-aware/array-aware expansion (`expandCommandArgs`) and must
      // not go through `prepareCommand`, which resolves a `$PATH` file that will never exist for
      // them - there is no `/bin/cd`, deliberately.
      const builtinName = command.compound ? undefined : trueBuiltinNameFor(command.words[0])
      // A shell function as one stage of a pipeline (`f | cat`) is run in this shell, in a subshell.
      const functionName = !command.compound && !builtinName && commands.length > 1 && this._functions.has(command.words[0] ?? '') ? command.words[0] : undefined
      // A compound stage (`... | while read x; do ...; done`) runs in this shell like a builtin does.
      const inProcess = Boolean(builtinName) || Boolean(command.compound) || Boolean(functionName)
      let resolved: { finalCommand: string | undefined, args: string[], typed?: string }
      try {
        resolved = command.compound
          ? { finalCommand: undefined, args: [] }
          : builtinName || functionName
            ? { finalCommand: undefined, args: await this.expandCommandArgs(command) }
            : await this.prepareCommand(command)
      } catch (error) {
        // A missing command fails that command with 127 and the script continues.
        if (!(error instanceof CommandNotFoundError)) throw error
        // From a startup file bash names the file and line: `/etc/ecmashrc: line 2: foo: command not found`.
        const where = this._sourceFile ? `${this._sourceFile}: line ${this.state.lineNumber}: ` : ''
        await this.shellDiagnostic(where + error.message)
        return commands.map(() => 127)
      }
      const args = resolved.args

      let stdin: ReadableStream<Uint8Array> | undefined
      let stdinFile: string | undefined
      let openStdin: (() => ReadableStream<Uint8Array>) | undefined
      let stdinSource: StdinSource | undefined
      let stdinLeftover: ((bytes: Uint8Array) => void) | undefined
      let stdinIsTTY = false
      // Applies to *any* stage, not only the first - `a | b < f` redirects b's stdin, discarding
      // whatever a's stdout would have fed it, exactly like a real shell.
      const inputRedirect = command.redirections.findLast(r => r.fd === 0 && (r.type === '<' || r.type === '<<' || r.type === '<<<'))
      if (inputRedirect) {
        // `cmd < file` hands a program the file itself as its stdin, not a pipe that a pump fills
        const direct = !inProcess && inputRedirect.type === '<' ? await this.directInputPath(inputRedirect) : undefined
        if (direct) {
          stdinFile = direct
          openStdin = () => this.createFileReadStream(direct, this.env, this._filesystem)
        } else stdin = await this.buildInputStream(inputRedirect)
      } else if (isFirstCommand) {
        // A redirected compound statement's input wins over the keyboard, and is shared rather than
        // reopened, so `while read a; do cat; done < f` hands `cat` what the loop has not read.
        const source = this.currentStdin
        if (source) {
          // Only a builtin gets the shared source, since it reads on demand. A real command gets a closed stdin:
          // `Kernel.bridgeStdio` pumps stdin eagerly and would drain the whole input into the first command. So
          // `while read a; do cat; done < f` gives `cat` nothing.
          stdinSource = inProcess ? source : undefined
          stdin = inProcess ? undefined : source.chunks()
          stdinLeftover = inProcess ? undefined : bytes => source.unread(bytes)
        } else {
          stdin = this._terminal.getInputStream()
          stdinIsTTY = true
        }
      } else {
        if (!prevReadable) throw new Error('Pipeline error: missing previous stream')
        stdin = prevReadable
      }

      // the pipe this command reads from, so it can be told its reader is gone once the command is
      const inputPipe = i > 0 ? prevPipe : undefined
      let pipeWritable: WritableStream<Uint8Array> | undefined
      if (!isLastCommand) {
        const pipe = buffered ? unboundedPipe() : this._createPipeStream()
        pipeWritable = pipe.writable
        prevReadable = pipe.readable
        prevPipe = pipe
      }

      // An enclosing aggregate command's redirections come first, so this command's own still win -
      // the same "later wins" rule applied across nesting levels. Resolved once per command, since
      // `inheritedOutputRedirections` also records which fds have already been truncated.
      const redirections = this._statementOutputs.length > 0 || this._execOutputs
        ? [...this.inheritedOutputRedirections(!isLastCommand), ...command.redirections]
        : command.redirections
      const blocked = await this.noclobberTarget(redirections)
      if (blocked) {
        await this.shellDiagnostic(`${blocked}: cannot overwrite existing file`)
        return commands.map(() => 1)
      }

      const { stdout, stderr } = await this.buildOutputStreams(redirections, isLastCommand, pipeWritable)
      const stdoutIsTTY = isLastCommand && this._heldStdout.length === 0 && !redirections.some(r => (r.type === '>' || r.type === '>>' || r.type === '>|' || r.type === '>&') && r.fd === 1)
      // Traced as written, not as resolved: bash's xtrace shows `+ echo hi`, not `+ /bin/echo hi`.
      await this.trace([command.words[0] ?? '', ...args])
      const fds = { args, stdin, stdinFile, openStdin, stdinSource, stdinLeftover, stdinIsTTY, stdout, stdoutIsTTY, drainStdout: isLastCommand, stderr, inputPipe }
      if (command.compound) {
        const statement = command.compound
        stages.push({ kind: 'compound', run: () => this.interpreter.runStage(statement), ...fds })
        continue
      }
      if (functionName) {
        stages.push({ kind: 'compound', run: () => this.interpreter.runFunctionStage(functionName, args), ...fds })
        continue
      }
      stages.push(builtinName
        ? {
            kind: 'builtin',
            name: builtinName,
            // `eval`/`source` run a statement tree, so their redirections have to reach everything
            // in it rather than only the builtin's own diagnostics.
            aggregate: aggregateBuiltinNames.has(builtinName) ? command.redirections : undefined,
            ...fds
          }
        : { kind: 'command', finalCommand: resolved.finalCommand as string, typed: resolved.typed, ...fds })
    }

    const runStage = async (stage: typeof stages[number]): Promise<number> => {
      const { args, stdin, stdinFile, openStdin, stdinSource, stdinLeftover, stdinIsTTY, stdout, stdoutIsTTY, drainStdout, stderr } = stage

      if (stage.kind === 'compound') {
        // What the stage was wired to has to reach the commands inside it: a pipe on its stdout is
        // written through by every one of them, and a pipe on its stdin is one shared input they read
        // in turn (`printf 'a\nb\n' | while read x; do echo $x; done`). The same wiring as `eval`.
        const turn = compoundTurn
        let release: () => void = () => {}
        compoundTurn = new Promise<void>(resolve => { release = resolve })
        await turn
        const source = stdinSource ?? (stdin && !stdinIsTTY ? new StdinSource(stdin) : undefined)
        const sharedOut = drainStdout ? undefined : stdout.getWriter()
        // a reader that has finished ends a loop writing into it (`while true; do echo x; done | head -n 1`),
        // as SIGPIPE ends the subshell in bash
        const view = () => new WritableStream<Uint8Array>({ write: async chunk => {
          try { await sharedOut?.write(chunk) } catch (error) {
            if ((error as { code?: string })?.code === 'EPIPE') throw new ExitSignal(141)
            throw error
          }
        } })
        if (sharedOut) { this._heldStdout.push(view); this._heldFloor.push(this._statementOutputs.length) }
        if (source && !stdinSource) this._stdinSources.push(source)
        try {
          return await stage.run()
        } finally {
          release()
          if (source && !stdinSource) { this._stdinSources.pop(); await source.close() }
          if (sharedOut) {
            this._heldStdout.pop(); this._heldFloor.pop()
            try { await sharedOut.close() } catch { sharedOut.releaseLock() }
          }
        }
      }

      if (stage.kind === 'builtin') {
        const name = stage.name
        const aggregate = stage.aggregate
        if (!aggregate) {
          const io = this.streamBuiltinIO(stdinSource ?? stdin, stdinIsTTY, stdout, stdoutIsTTY, stderr)
          try { return await runTrueBuiltin(this, name, args, io) } finally { await io.close() }
        }

        // An aggregate builtin runs commands of its own, so what its stage was wired to has to reach
        // them: a pipe on its stdout is written through by every command inside, and a pipe or file
        // on its stdin is one shared input they read in turn (`echo x | eval cat`).
        const source = stdinSource ?? (stdin && !stdinIsTTY ? new StdinSource(stdin) : undefined)
        const sharedOut = drainStdout ? undefined : stdout.getWriter()
        const view = () => new WritableStream<Uint8Array>({ write: async chunk => { await sharedOut?.write(chunk) } })
        const io = this.streamBuiltinIO(source ?? stdin, stdinIsTTY, sharedOut ? view() : stdout, stdoutIsTTY, stderr)
        if (sharedOut) { this._heldStdout.push(view); this._heldFloor.push(this._statementOutputs.length) }
        if (source && !stdinSource) this._stdinSources.push(source)
        try {
          return await this.withStatementRedirections(aggregate, () => runTrueBuiltin(this, name, args, io))
        } finally {
          if (source && !stdinSource) this._stdinSources.pop()
          if (sharedOut) { this._heldStdout.pop(); this._heldFloor.pop() }
          await io.close()
          if (sharedOut) { try { await sharedOut.close() } catch { sharedOut.releaseLock() } }
        }
      }

      return await this._execute({
        command: stage.finalCommand,
        invokedAs: stage.typed?.includes('/') ? stage.typed : undefined,
        args,
        shell: this,
        terminal: this._terminal,
        stdin,
        stdinFile,
        openStdin,
        stdinLeftover,
        stdinIsTTY,
        stdout,
        stdoutIsTTY,
        drainStdout,
        stderr,
        onProcess: job ? (process => { job.processes.push(process); this.shareTerminalSignals(job, process) }) : undefined,
        foreground: job ? !job.background : true
      })
    }
    const results = await Promise.all(stages.map(async stage => {
      try { return await runStage(stage) } finally {
        // a stage that has finished reads nothing more: whatever still writes into its pipe is told so
        stage.inputPipe?.abandon?.()
      }
    }))

    return pipeline.negated ? results.map(code => code === 0 ? 1 : 0) : results
  }

  /** Notices for finished background jobs, polled at prompt time. Reporting retires the job. */
  takeJobNotifications(): string[] {
    const background = this._jobs.filter(job => job.background || job.status === 'stopped')
    const current = background[background.length - 1]?.id
    const previous = background.length > 1 ? background[background.length - 2]?.id : undefined
    const lines: string[] = []
    for (const job of this._jobs) {
      if (job.status !== 'done' || !job.background || job.notified) continue
      job.notified = true
      const marker = job.id === current ? '+' : job.id === previous ? '-' : ' '
      lines.push(`[${job.id}]${marker}  ${jobStatusLabel(job).padEnd(27)}${job.commandLine} &`)
    }
    return lines
  }

  /** Forgets a job without touching its processes (`disown`): no more `jobs` entry and no Done notice. */
  removeJob(job: Job): void {
    this._jobs = this._jobs.filter(candidate => candidate !== job)
  }

  /** All tracked jobs, oldest first. See `_jobs`'s doc comment for retention behavior. */
  listJobs(): Job[] {
    return [...this._jobs]
  }

  /** The most recent background or stopped job; what `%%`, `%+` and bare `fg`/`bg` target. */
  private get currentJob(): Job | undefined {
    for (let i = this._jobs.length - 1; i >= 0; i--) {
      const job = this._jobs[i]
      if (job && (job.background || job.status === 'stopped')) return job
    }
    return undefined
  }

  /** Resolves a job spec: `%N`, `%%`/`%+`, `%-`, a pid, or none (the current job). Undefined if nothing matches. */
  getJob(spec?: string): Job | undefined {
    if (!spec) return this.currentJob

    if (spec.startsWith('%')) {
      const rest = spec.slice(1)
      if (rest === '' || rest === '%' || rest === '+') return this.currentJob
      if (rest === '-') {
        const backgroundable = this._jobs.filter(job => job.background || job.status === 'stopped')
        return backgroundable[backgroundable.length - 2]
      }

      const id = Number(rest)
      if (!Number.isNaN(id)) return [...this._jobs].reverse().find(job => job.id === id)

      // %name: the most recent job whose command line starts with `name`, e.g. `%sleep`
      return [...this._jobs].reverse().find(job => job.commandLine.startsWith(rest))
    }

    const pid = Number(spec)
    if (!Number.isNaN(pid)) {
      const byProcess = this._jobs.find(job => job.processes.some(process => process.pid === pid))
      // `$!` of a job with no process of its own is its job id, which names that job.
      return byProcess ?? (pid === this._lastBackgroundPid ? this._lastBackgroundJob : undefined)
    }

    return undefined
  }

  /** Resumes a stopped job with `SIGCONT`, or brings a background job to the foreground, and waits for it. */
  async fg(spec?: string): Promise<number | undefined> {
    const job = this.getJob(spec)
    if (!job) return undefined

    this._terminal.writeln(job.commandLine)

    if (job.status === 'stopped') {
      for (const process of job.processes) process.kill(Signal.CONT)
      job.status = 'running'
    }

    // Reclaim the controlling terminal for this job's real process(es) - it gave it up (or never
    // had it) while backgrounded/stopped; see `JobProcessHandle.setForeground`'s doc comment.
    for (const process of job.processes) process.setForeground?.(true)

    this._foregroundJob = job
    try {
      const codes = await job.done
      return codes[codes.length - 1]
    } finally {
      if (this._foregroundJob === job) this._foregroundJob = undefined
    }
  }

  /**
   * `^C`, `^Z` and `^\` reach the terminal's one foreground process; this passes them on to the other stages of its
   * job, so a whole pipeline stops. Signals sent by pid, or other signals, reach only the one process.
   */
  private shareTerminalSignals(job: Job, process: JobProcessHandle): void {
    const deliver = process.kill.bind(process)
    process.kill = (signal: number | string) => {
      const fromTerminal = TerminalSignals.has(signal as number) &&
        this._foregroundJob === job &&
        this._terminal.zfsTty?.foreground?.pid === process.pid
      const delivered = deliver(signal)
      if (fromTerminal) for (const peer of job.processes) if (peer !== process) peer.kill(signal)
      return delivered
    }
  }

  /** Resumes a stopped job with `SIGCONT` in the background, without waiting for it. */
  bg(spec?: string): Job | undefined {
    const job = this.getJob(spec)
    if (!job || job.status !== 'stopped') return job

    for (const process of job.processes) process.kill(Signal.CONT)
    for (const process of job.processes) process.setForeground?.(false)
    job.status = 'running'
    job.background = true
    this._terminal.writeln(`[${job.id}]+ ${job.commandLine} &`)
    return job
  }

  /** Waits for one job or pid, or for every running or stopped background job when called with none. */
  async wait(spec?: string): Promise<number | undefined> {
    if (!spec) {
      // Background jobs only: a foreground pipeline is also in the table, and `wait` itself (or the
      // script that called it) is one whenever it runs through `runPipeline`, as it does under `exec >`.
      await Promise.all(this._jobs.filter(job => job.background && job.status !== 'done').map(job => job.done))
      return undefined
    }

    const job = this.getJob(spec)
    if (!job) return undefined

    const codes = await job.done
    return codes[codes.length - 1]
  }

  /** The function a single-command pipeline calls, if its command names a registered function. */
  private functionNameFor(pipeline: Pipeline): string | undefined {
    if (pipeline.commands.length !== 1) return undefined
    const command = pipeline.commands[0]
    // `NAME=v f`: the function is the command after the assignments
    const name = command ? splitAssignments(command).command.words[0] : undefined
    return name && this._functions.has(name) ? name : undefined
  }

  /**
   * The builtin a single-command pipeline runs in place (nothing redirected), if any. Redirected or piped builtins
   * run as a stage in `runPipeline`.
   */
  private fastPathBuiltinFor(pipeline: Pipeline): string | undefined {
    // With `exec > file` installed there is no such thing as "nothing redirected": the shell's own
    // fd 1 is the file, and a builtin writing straight to the terminal would escape it.
    // Likewise inside `eval`/`source` that sits in a pipeline: its stdout is the pipe, held for what runs inside.
    if (this._execOutputs || this._statementOutputs.length > 0 || this._heldStdout.length > 0) return undefined
    if (pipeline.commands.length !== 1) return undefined
    const command = pipeline.commands[0]
    if (!command || command.redirections.length > 0) return undefined
    return trueBuiltinNameFor(command.words[0])
  }

  /** One word's fields, with brace expansion applied first (`a.{txt,bak}`, `{1..5}`). */
  private async expandFields(parts: WordPart[], ctx: ExpansionContext): Promise<string[]> {
    return await expandWordFieldsBraced(parts, ctx)
  }

  /**
   * Expands a command's argument words (index 1..) with the quote-aware expander - true builtins and functions bypass
   * `prepareCommand`, so they need their own array/word-splitting-aware path.
   */
  private async expandCommandArgs(command: ParsedCommand): Promise<string[]> {
    const ctx = this.expansionContext()
    const fields: string[] = []
    for (let i = 1; i < command.words.length; i++) {
      const parts = command.wordParts[i]
      fields.push(...(parts && parts.length ? await this.expandFields(parts, ctx) : [command.words[i] as string]))
    }
    // `$_`: the last word of the command, which the next one reads
    this.state.set('_', fields.length ? fields[fields.length - 1] as string : command.words[0] ?? '')
    return fields
  }

  /** Runs a `[[ ... ]]` compound test, returning bash's own 0/1 exit convention. Sets `BASH_REMATCH` on `=~`. */
  private async evaluateConditionalCommand(text: string): Promise<number> {
    const tokens = tokenizeConditional(text)
    const fs: ConditionalFs = {
      exists: (p) => this.context.fs.promises.exists(p),
      isFile: async (p) => { try { return (await this.context.fs.promises.stat(p)).isFile() } catch { return false } },
      isDirectory: async (p) => { try { return (await this.context.fs.promises.stat(p)).isDirectory() } catch { return false } },
      resolve: (p) => path.resolve(this.cwd, p),
      test: words => testExpression(kernelBuiltinHost(this), words)
    }
    try {
      const result = await evaluateConditional(tokens, this.expansionContext(), fs, (groups) => this.setArray('BASH_REMATCH', groups))
      return result ? 0 : 1
    } catch {
      return 2
    }
  }

  /**
   * Calls a registered function with its own `local` scope and positional parameters `argv`. `return` unwinds to
   * here; `break` and `continue` stop here too, so a function cannot break its caller's loop.
   */
  private async callFunction(name: string, argv: string[]): Promise<number> {
    return await this.interpreter.callFunction(name, argv)
  }

  /**
   * Runs `text` in this shell (`source`, `eval`): variables, functions and `cd` persist. The `EXIT` trap does not
   * run, `return` is caught, and `exit` is not. `positional` replaces `$1..` for the duration.
   */
  async executeSourced(text: string, positional?: string[], file?: string): Promise<number> {
    return await this.interpreter.runSourced(text, positional, file)
  }

  /** True when `PROMPT_COMMAND` has something to run, so the prompt can skip the async hop when it does not. */
  hasPromptCommand(): boolean {
    return promptCommands(this.state).length > 0
  }

  /** Runs `PROMPT_COMMAND` before the primary prompt, preserving `$?`. */
  async runPromptCommand(): Promise<void> {
    const status = this.env.get('?')
    try {
      for (const text of promptCommands(this.state)) {
        try { await this.executeSourced(text) } catch (error) { if (isControlFlowSignal(error)) break }
      }
    } finally {
      if (status !== undefined) this.env.set('?', status)
    }
  }

  /**
   * Executes a line typed at the prompt. Lines with control flow go through `parseStatements` and
   * `executeStatements`; a line that does not parse is a syntax error (status 2) and runs nothing.
   */
  async execute(line: string): Promise<number> {
    const trimmed = stripComments(line).trim()
    if (!trimmed) return 0

    // A fresh line is never pre-interrupted: `^C` aborts the line it happened during, not the next.
    // Only at depth 0 - see `_executeDepth`.
    if (this._executeDepth === 0) { this._interrupted = false; this._interruptClaimed = false }
    this._executeDepth++
    try {
      return await this.executeParsed(trimmed)
    } catch (signal) {
      // The outermost `execute()` turns an uncaught `exit` into an exit code and sets `$?`; stray `break`, `continue`
      // and `return` are reported.
      if (signal instanceof ExitSignal && this._signalCatchers.exit === 0) {
        this.onExit?.(signal.code)
        return this.reportExit(signal.code)
      }
      if (signal instanceof ReturnSignal && this._signalCatchers.return === 0) {
        await this.terminalBuiltinIO().writelnErr("return: can only `return' from a function or sourced script")
        return this.reportExit(1)
      }
      if ((signal instanceof BreakSignal || signal instanceof ContinueSignal) && this._signalCatchers.loop === 0) {
        await this.terminalBuiltinIO().writelnErr(`${signal.message}: only meaningful in a \`for', \`while', or \`until' loop`)
        return this.reportExit(0)
      }
      if (signal instanceof ParseError) {
        await this.terminalBuiltinIO().writelnErr(syntaxMessage(signal.message))
        return this.reportExit(2)
      }
      throw signal
    } finally {
      this._executeDepth--
    }
  }

  /** Records `code` as `$?` and returns it, for signals that unwind past `executeSimple`. */
  private reportExit(code: number): number {
    this.env.set('?', String(code))
    return code
  }

  /** The body of {@link execute}, minus the interrupt bookkeeping that must not nest. */
  private async executeParsed(trimmed: string): Promise<number> {

    let statements: Statement[]
    try {
      statements = parseStatements(trimmed)
    } catch (error) {
      // A line that does not parse is not run, as in bash: `fi`, or `a | while x; do` and no `done`
      if (!(error instanceof ControlFlowParseError)) throw error
      await this.terminalBuiltinIO().writelnErr(controlFlowMessage(error))
      return this.reportExit(2)
    }

    if (statements.length !== 1 || statements[0]?.type !== 'simple') {
      return this.executeStatements(statements)
    }

    // Runs the parsed line, which has heredoc bodies folded into it, not the raw text.
    await this.traceVerbose(statements[0].line)
    return this.executeSimple(this.expandAliases(statements[0].line))
  }

  /**
   * Executes one simple command line, walking its `;`, `&&`, `||` and `&` stages. A `&` stage becomes a background
   * `Job` and prints `[id] pid`; the rest run in the foreground and are awaited. Honors `set -e` and `pipefail`.
   */
  private async executeSimple(line: string): Promise<number> {
    return await this.interpreter.runLine(line)
  }

  /**
   * What the shared interpreter needs from this shell: running a pipeline, and the `$?` and positional parameters
   * kept in the variable map.
   */
  private hostInterface(): InterpreterHost {
    return {
      runPipeline: pipeline => this.runStage(pipeline),
      runBackground: async pipeline => { await this.runInBackground(pipeline); return 0 },
      prepareLine: line => stripComments(line).trim(),
      expandStatement: line => this.expandAliases(line),
      onStatement: async statement => { if (statement.type === 'simple') await this.traceVerbose(statement.line) },
      // Array assignments are read from the raw text: the tokenizer splits `a=(x y)` in two.
      runSpecial: line => this.runArrayAssignment(line),
      withRedirect: (statement, run) => this.withStatementRedirection(statement, run),
      expandWords: text => this.expandForWords(text),
      // the full expander, so `$-`, `$#`, `${x:-d}` and the rest work here as in any other word; a subject is not
      // split into fields
      caseSubject: async word => (await this.expandForWords(word)).join(' '),
      matchesPattern: (subject, pattern) => this.matchesCasePattern(subject, pattern),
      assign: (name, value) => this.setVariable(name, value),
      enterParameters: (args, zero) => {
        const saved = new Map<string, string>()
        for (const key of this.env.keys()) if (!isNaN(parseInt(key))) saved.set(key, this.env.get(key) as string)
        // `setPositionalParameters` sets $0 to its first element, so the caller's own name goes first and
        // $1 stays the first real argument.
        this.setPositionalParameters([zero ?? this.env.get('0') ?? 'ecmaos', ...args])
        return () => {
          this.clearPositionalParameters()
          for (const [key, value] of saved) this.env.set(key, value)
        }
      },
      // There is no fork, so a subshell is a snapshot: variables (which is also where the positional
      // parameters live), arrays, functions, options, traps and the working directory are put back
      // afterwards, so `(set -e; ...)` does not leave `set -e` on in the shell around it.
      snapshot: () => {
        const options = { ...this.state.options }
        const traps = new Map(this.state.traps)
        const env = new Map(this._env)
        const arrays = new Map([...this._arrays].map(([name, array]) => [name, new Map(array)]))
        const functions = new Map(this._functions)
        const cwd = this._cwd
        const dirStack = [...this.state.dirStack]
        // `exec` redirections made inside the parentheses end with them
        const execOutputs = this._execOutputs
        const stdinSources = [...this._stdinSources]
        const inputFds = new Map(this._inputFds)
        return () => {
          this._execOutputs = execOutputs
          this._stdinSources = stdinSources
          this._inputFds = inputFds
          this.state.dirStack = dirStack
          this._arrays = arrays
          this._functions = functions
          this._cwd = cwd
          this.env = env
          this.state.options = options
          this.state.traps = traps
        }
      },
      getStatus: () => Number(this.env.get('?') ?? 0),
      setStatus: code => { this.env.set('?', String(code)) },
      checkpoint: async () => this._interrupted,
      exitShell: async code => { throw new ExitSignal(code) },
      writeErr: message => this.shellDiagnostic(message),
    }
  }

  /** `a=(x y)`, `a+=(z)` and `a[i]=v`. `undefined` when the line is not one. */
  private async runArrayAssignment(line: string): Promise<number | undefined> {
    const found = parseArrayAssignment(line)
    if (!found) return undefined
    const ctx = this.expansionContext()
    await applyArrayAssignment(found, this.state, {
      fields: parts => this.expandFields(parts, ctx),
      text: parts => expandWordString(parts, ctx),
      lookup: name => this.lookupVariable(name)
    })
    if (!found.rest || found.operator === '||') return 0
    return await this.interpreter.runLine(found.rest)
  }

  /**
   * `X=1 Y=2` with no command: sets the variables here. A readonly name fails the command; the status is that of the
   * last `$(...)` in the values.
   */
  private async runAssignments(assignments: Assignment[]): Promise<number> {
    this._substitutionStatus = undefined
    for (const { name, append, parts } of assignments) {
      const value = await expandWordString(parts, this.expansionContext())
      try {
        this.setVariable(name, value, append)
      } catch (error) {
        await this.shellDiagnostic(error instanceof Error ? error.message : String(error))
        this.state.failedLine = this.state.lineNumber
        return 1
      }
    }
    return this._substitutionStatus ?? 0
  }

  /**
   * Runs one foreground pipeline and returns each stage's status, dispatching on `exec`, `[[ ]]`, builtin, function
   * or program.
   */
  private async runStage(pipeline: Pipeline): Promise<number[]> {
    // `exec` never reaches the builtin table: its redirections are the point, so they must be
    // installed rather than handed to it as its own fds the way every other builtin's are.
    const execCommand = pipeline.commands.length === 1 && pipeline.commands[0]?.words[0] === 'exec'
      ? pipeline.commands[0]
      : undefined
    const conditionalCommand = execCommand ? undefined : (pipeline.commands.length === 1 ? pipeline.commands[0] : undefined)
    const builtinName = conditionalCommand?.conditional !== undefined ? undefined : this.fastPathBuiltinFor(pipeline)
    const fnName = builtinName ? undefined : this.functionNameFor(pipeline)
    const negate = (code: number) => pipeline.negated ? (code === 0 ? 1 : 0) : code

    if (pipeline.commands.length === 1) {
      const split = splitAssignments(pipeline.commands[0] as ParsedCommand)
      if (split.assignments.length > 0 && split.command.words.length === 0) return [negate(await this.runAssignments(split.assignments))]
    }

    if (execCommand) return [negate(await this.runExec(execCommand))]
    if (conditionalCommand?.conditional !== undefined) return [negate(await this.evaluateConditionalCommand(conditionalCommand.conditional))]

    if (builtinName) {
      // True builtins win over functions and files, so a function cannot shadow `cd`.
      const command = pipeline.commands[0] as ParsedCommand
      const args = await this.expandCommandArgs(command)
      await this.trace([builtinName, ...args])
      return [negate(await runTrueBuiltin(this, builtinName, args, this.terminalBuiltinIO()))]
    }

    if (fnName) {
      // A function's body is a statement tree, not a command with fds, so `greet > f` is held as an aggregate
      // redirection for the whole call.
      const split = splitAssignments(pipeline.commands[0] as ParsedCommand)
      const command = split.command
      // Prefix assignments are in the function's environment for the call and put back after it.
      const restore = split.assignments.length > 0 ? await this.applyAssignmentPrefixes(split.assignments) : undefined
      try {
        const args = await this.expandCommandArgs(command)
        await this.trace([fnName, ...args])
        return [negate(await this.withStatementRedirections(command.redirections, () => this.callFunction(fnName, args)))]
      } finally {
        restore?.()
      }
    }

    return await this.runForeground(pipeline)
  }

  /** Runs a pipeline as `foregroundJob` so signals reach it, and clears it when it settles. */
  private async runForeground(pipeline: Pipeline): Promise<number[]> {
    const job = this.createJob(pipeline, false, /* rethrow */ true)
    this._foregroundJob = job
    try {
      return await job.done
    } finally {
      if (this._foregroundJob === job) this._foregroundJob = undefined
    }
  }

  /**
   * Launches a pipeline in the background: registers a `Job`, prints `[id] pid` and does not await it. Waits for the
   * first process so `$!` is real.
   */
  private async runInBackground(pipeline: Pipeline): Promise<void> {
    const job = this.createJob(pipeline, true, /* rethrow */ false)

    let finished = false
    void job.done.then(() => { finished = true })
    const deadline = Date.now() + 300
    while (!job.processes[0] && !finished && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))

    const pid = job.processes[0]?.pid
    // `$!` is whatever `[1] <pid>` just reported, including the job-id fallback for an
    // all-coreutils pipeline that never produced a real process.
    this._lastBackgroundPid = pid ?? job.id
    this._lastBackgroundJob = job
    this._terminal.writeln(`[${job.id}] ${pid ?? job.id}`)
  }

  /**
   * Registers a `Job` and starts `runPipeline` against it so process handles are added as they appear.
   * @param rethrow - foreground jobs propagate errors to the caller; background jobs report them to the terminal and
   * fail `job.done`.
   */
  private createJob(pipeline: Pipeline, background: boolean, rethrow: boolean): JobImpl {
    const commandLine = pipeline.commands.map(command => command.compound ? compoundLabel(command.compound) : command.words.join(' ')).join(' | ')
    // as in bash the numbers start again once nothing is left to refer to: a job that has finished (and, for a
    // background one, been reported) no longer holds its number
    const live = this._jobs.filter(job => job.status !== 'done' || (job.background && !job.notified))
    // without this every command a script or a test runs stays in the table, and each next one pays for walking it;
    // the latest job stays so a caller can still look at the one that just ended
    const latest = this._jobs[this._jobs.length - 1]
    this._jobs = latest && !live.includes(latest) ? [...live, latest] : live
    const job = new JobImpl(live.reduce((highest, other) => Math.max(highest, other.id), 0) + 1, commandLine, background)
    const settle = (codes: number[]) => {
      job.exitCodes = codes
      job.status = 'done'
      return codes
    }

    job.done = rethrow
      ? this.runPipeline(pipeline, job).then(settle)
      : this.runPipeline(pipeline, job).then(settle).catch(error => {
          this._terminal.writeln(`${this.env.get('SHELL') || 'ecmaos'}: ${error instanceof Error ? error.message : String(error)}`)
          return settle([-1])
        })

    this._jobs.push(job)
    return job
  }

  /**
   * Runs a statement tree: plain lines through `execute()`, control-flow nodes interpreted here. `break`, `continue`,
   * `return` and `exit` are builtins that throw signals caught by the nearest loop, `callFunction` or
   * `executeScriptText`.
   */
  async executeStatements(statements: Statement[]): Promise<number> {
    return await this.interpreter.runStatements(statements)
  }

  /**
   * `exec [redirection...]`: installs redirections on the shell itself (`exec > log 2>&1`). The command form is
   * reported as unsupported, since the shell is not a worker program.
   */
  private async runExec(command: ParsedCommand): Promise<number> {
    const args = await this.expandCommandArgs(command)
    if (args.length > 0) {
      // There is no process image to replace, so run the command and leave with its status, which is what `exec`
      // looks like from outside (a subshell ends the same way). Its redirections apply to it alone.
      const argv = args[0] === '--' ? args.slice(1) : args
      const code = await this.withStatementRedirections(command.redirections, () => this.execute(argv.map(shellQuote).join(' ')))
      throw new ExitSignal(code)
    }

    const outputs = command.redirections.filter(r => r.fd !== 0 && (r.type === '>' || r.type === '>>' || r.type === '>|' || r.type === '>&'))
    if (outputs.length > 0) this._execOutputs = { redirections: outputs, truncated: new Set(), after: this._statementOutputs.length }

    // `exec 3<file`: a numbered input stays open on the shell for `read -u 3`.
    for (const r of command.redirections) {
      if (r.fd >= 3 && (r.type === '<' || r.type === '<<' || r.type === '<<<')) {
        await this._inputFds.get(r.fd)?.close()
        this._inputFds.set(r.fd, new StdinSource(await this.buildInputStream(r)))
      }
    }

    const input = command.redirections.findLast(r => r.fd === 0 && (r.type === '<' || r.type === '<<' || r.type === '<<<'))
    if (input) {
      // Installed at the bottom of the stack, so a redirected compound statement still wins while it
      // is running and this is what is left underneath when it finishes.
      this._stdinSources.unshift(new StdinSource(await this.buildInputStream(input)))
    }

    return 0
  }

  /**
   * Runs a compound statement with its trailing redirection in effect: one input shared by every `read` in the body,
   * one output shared by every command.
   */
  private async withStatementRedirection(statement: Redirected, run: () => Promise<number>): Promise<number> {
    if (!statement.redirect) return await run()

    const redirections = parseRedirections(statement.redirect)
    return await this.withStatementRedirections(redirections, run)
  }

  /**
   * Holds redirections for the duration of an aggregate command (compound statement, function call, `eval`/`source`).
   */
  private async withStatementRedirections(redirections: readonly Redirection[], run: () => Promise<number>): Promise<number> {
    // A `done < <(cmd)` expands its target here, outside any pipeline, so its substitution has to be
    // cleaned up here too.
    const mark = this._processSubstitutions.length
    try {
      return await this.withStatementOutputs(redirections, async () => {
        const pop = await this.pushStatementStdin(redirections)
        if (!pop) return await run()
        try {
          return await run()
        } finally {
          await pop()
        }
      })
    } finally {
      await this.finishProcessSubstitutions(mark)
    }
  }

  /**
   * A `for` list's values, expanded like command arguments (quotes, `$IFS` splitting, substitution, arithmetic,
   * globbing).
   */
  private async expandForWords(wordsText: string): Promise<string[]> {
    if (wordsText === '') return []
    const ctx = this.expansionContext()
    const values: string[] = []
    for (const token of tokenize(wordsText)) {
      if (token.kind !== 'word') continue
      values.push(...await this.expandFields(token.parts ?? [], ctx))
    }
    return values
  }

  /** `*` matches anything; other patterns are matched as shell globs (`?` any char, literal else). */
  private matchesCasePattern(value: string, pattern: string): boolean {
    if (pattern === '*') return true
    // the same glob rules as `[[ == ]]`: `[ab]` classes and `\` escapes, with the pattern's quotes taken off
    return globRegExp(pattern.replace(/^["']|["']$/g, ''), { extglob: this.state.shopts.has('extglob'), nocase: this.state.shopts.has('nocasematch') }).test(value)
  }

  /** Runs a full script's text to completion; `Kernel.executeScript`'s entry point. */
  async executeScriptText(script: string, file?: string, args?: string[]): Promise<number> {
    // bash reads a script a command at a time: the commands before a line that does not parse run, then it stops
    let parsed: ReturnType<typeof parseRunnable>
    try {
      parsed = parseRunnable(script)
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
      await this.terminalBuiltinIO().writelnErr(syntaxMessage(error.message))
      return this.reportExit(2)
    }
    this._signalCatchers.exit++
    // `./script a b`: the arguments are `$1 $2` for the run and the caller's own come back afterwards.
    const callerArgs = args ? this.positionalParameters : undefined
    if (args) { this.clearPositionalParameters(); args.forEach((arg, index) => this.env.set(String(index + 1), arg)) }
    // Running a file: `$0` names it for the duration, and so does `BASH_SOURCE`.
    const previousName = this._env.get('0')
    if (file !== undefined) { this.state.pushSourceFrame(file, 0); this._env.set('0', file) }
    try {
      const status = await this.executeStatements(parsed.statements)
      if (!parsed.failure) return status
      await this.terminalBuiltinIO().writelnErr(controlFlowMessage(parsed.failure))
      return this.reportExit(2)
    } catch (signal) {
      // `exit N` ends the script with code N. The `EXIT` trap still runs, in the `finally` below,
      // because that is precisely when bash runs it.
      if (signal instanceof ExitSignal) { this.reportExit(signal.code); return signal.code }
      // Lines before the bad one have run, as bash reads a script a line at a time.
      if (signal instanceof ParseError) {
        await this.terminalBuiltinIO().writelnErr(syntaxMessage(signal.message))
        return this.reportExit(2)
      }
      throw signal
    } finally {
      this._signalCatchers.exit--
      await this.runTrap('EXIT')
      if (callerArgs) { this.clearPositionalParameters(); callerArgs.forEach((arg, index) => this.env.set(String(index + 1), arg)) }
      if (file !== undefined) {
        this.state.popSourceFrame()
        if (previousName === undefined) this._env.delete('0')
        else this._env.set('0', previousName)
      }
    }
  }

  /**
   * Creates a ReadableStream that reads from a file
   */
  /** A lazy stream over a file or device, reading one chunk per `pull`. */
  private createFileReadStream(
    sourcePath: string,
    env: Map<string, string>,
    filesystem: Filesystem
  ): ReadableStream<Uint8Array> {
    const chunkSize = parseInt(
      env.get('SHELL_INPUT_REDIRECTION_CHUNK_SIZE') ||
      import.meta.env.ECMAOS_APP_SHELL_INPUT_REDIRECTION_CHUNK_SIZE ||
      '8192'
    )

    let handle: Awaited<ReturnType<Filesystem['fs']['open']>> | undefined
    let done = false

    const finish = async (): Promise<void> => {
      done = true
      const open = handle
      handle = undefined
      await open?.close()
    }

    return new ReadableStream({
      async start() {
        // A character device that reads as EOF (`/dev/null`) is recognized here, since no driver can say so.
        const stats = await filesystem.fs.stat(sourcePath)
        if (stats.isCharacterDevice() && readsAsEof(stats.rdev)) {
          done = true
          return
        }
        handle = await filesystem.fs.open(sourcePath, 'r')
      },

      async pull(controller) {
        if (done || !handle) {
          controller.close()
          return
        }

        const buffer = new Uint8Array(chunkSize)
        const { bytesRead } = await handle.read(buffer, 0, chunkSize)
        // Anything that isn't a positive count is end of file, not a short read to retry.
        if (typeof bytesRead !== 'number' || !(bytesRead > 0)) {
          await finish()
          controller.close()
          return
        }

        controller.enqueue(buffer.slice(0, bytesRead))
      },

      // The consumer stopped early (`head -c 4`), so drop the handle rather than leaking it.
      async cancel() {
        await finish()
      }
    })
  }

  /**
   * Creates a WritableStream that writes to a file
   */
  private async isCharacterDevice(targetPath: string): Promise<boolean> {
    const info = await this.context.fs.promises.stat(targetPath).catch(() => undefined)
    return Boolean(info && (info.mode & 0o170000) === 0o020000)
  }

  private createFileWriteStream(targetPath: string, append: boolean, isDevice = false): WritableStream<Uint8Array> {
    const context = this.context

    // The target is rewritten whole from what has been collected, never appended: `appendFile` on the root filesystem
    // writes each chunk at offset 0. Throttled to every 250ms while output flows, and always on close or abort.
    let base = new Uint8Array()
    const chunks: Uint8Array[] = []
    let dirty = false
    let lastFlush = 0

    const flush = async () => {
      if (!dirty) return
      dirty = false
      lastFlush = Date.now()
      const all = new Uint8Array(base.length + chunks.reduce((n, c) => n + c.length, 0))
      all.set(base, 0)
      let at = base.length
      for (const chunk of chunks) { all.set(chunk, at); at += chunk.length }
      await context.fs.promises.writeFile(targetPath, all, { mode: 0o666 & ~this._umask })
    }

    // A character device is not rewritten whole: it takes the bytes as they come, through a handle, and a node whose session
    // is still opening answers `EAGAIN` until it has one
    let device: Awaited<ReturnType<typeof context.fs.promises.open>> | undefined
    const writeToDevice = async (chunk: Uint8Array) => {
      let done = 0
      const give = Date.now() + 10_000
      while (done < chunk.length) {
        try {
          const { bytesWritten } = await device!.write(chunk, done, chunk.length - done)
          done += bytesWritten
        } catch (error) {
          if ((error as { code?: string }).code !== 'EAGAIN' || Date.now() > give) throw error
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
    }

    return new WritableStream({
      // A real shell opens (creating, and for `>` truncating) the target before the command runs,
      // so `cmd > f` leaves `f` empty even if `cmd` never writes a byte.
      start: async () => {
        if (isDevice) {
          device = await context.fs.promises.open(targetPath, 'w')
          return
        }
        const existed = append && await context.fs.promises.exists(targetPath)
        if (existed) base = new Uint8Array(await context.fs.promises.readFile(targetPath))
        else {
          // Two streams can open the same new target at once (a command and the aggregate builtin around
          // it, `env echo hi >> new`); the one that loses the race finds the file already there.
          try { await context.fs.promises.writeFile(targetPath, new Uint8Array(), { mode: 0o666 & ~this._umask }) } catch (error) {
            if ((error as { code?: string }).code !== 'EEXIST') throw error
            if (append) base = new Uint8Array(await context.fs.promises.readFile(targetPath))
          }
        }
      },
      write: async (chunk) => {
        if (device) return await writeToDevice(chunk)
        chunks.push(chunk.slice())
        dirty = true
        if (Date.now() - lastFlush >= 250) await flush()
      },
      close: async () => { if (device) await device.close(); else await flush() },
      abort: async () => { if (device) await device.close().catch(() => {}); else await flush() }
    })
  }

  /**
   * Creates a WritableStream that writes to the terminal
   */
  /**
   * A builtin's fds when it is a lone command with nothing redirected: straight to the terminal, with no streams.
   * `readLine` uses `terminal.readline()`.
   */
  /**
   * The input a redirected compound statement opened, if any; preferred over the terminal by `read` and first-stage
   * commands.
   */
  private get currentStdin(): StdinSource | undefined {
    return this._stdinSources[this._stdinSources.length - 1]
  }

  /** `set -C`: the first target a plain `>` would destroy, if any. Reported, not thrown, so the script continues. */
  private async noclobberTarget(redirections: readonly Redirection[]): Promise<string | undefined> {
    if (!this._shellOptions.noclobber) return undefined
    for (const redirection of redirections) {
      if (redirection.type !== '>') continue
      const target = path.resolve(this.cwd, await this.expandRedirectionTarget(redirection))
      if (await this.context.fs.promises.exists(target)) return target
    }
    return undefined
  }

  /** A redirection target word, expanded. Quote-aware, so `> "$dir/a b"` is one filename. */
  private async expandRedirectionTarget(redirection: Redirection): Promise<string> {
    const parts = redirection.targetParts
    if (!parts || parts.length === 0) return redirection.target
    return await expandWordString(parts, this.expansionContext())
  }

  /** The stream behind one input redirection: a heredoc, a here-string or a file. */
  /** The absolute path of a `< file` target when it is a file or a device that can be opened as a descriptor, else `undefined` (a missing file is reported by `buildInputStream`) */
  private async directInputPath(redirection: Redirection): Promise<string | undefined> {
    const target = path.resolve(this.cwd, await this.expandRedirectionTarget(redirection))
    const info = await this.context.fs.promises.stat(target).catch(() => undefined)
    if (!info) return undefined
    const type = info.mode & 0o170000
    return type === 0o100000 || type === 0o020000 ? target : undefined
  }

  private async buildInputStream(redirection: Redirection): Promise<ReadableStream<Uint8Array>> {
    const literal = (text: string): ReadableStream<Uint8Array> => new ReadableStream({
      start: controller => { controller.enqueue(new TextEncoder().encode(text)); controller.close() }
    })

    if (redirection.type === '<<') {
      const heredoc = redirection.heredoc as { body: string, expand: boolean }
      return literal(heredoc.expand ? await expandHeredocBody(heredoc.body, this.expansionContext()) : heredoc.body)
    }

    const target = await this.expandRedirectionTarget(redirection)

    if (redirection.type === '<<<') return literal(target + '\n')

    const sourcePath = path.resolve(this.cwd, target)
    if (!await this.context.fs.promises.exists(sourcePath)) throw new Error(`File not found: ${sourcePath}`)
    return this.createFileReadStream(sourcePath, this.env, this._filesystem)
  }

  /**
   * Enclosing aggregate commands' output redirections, outermost first, with an already-truncating `>` rewritten as
   * `>>` so the body writes one stream. With `notLast`, fd 1 redirections are omitted (the stage feeds a pipe).
   */
  private inheritedOutputRedirections(notLast = false): Redirection[] {
    const inherited: Redirection[] = []
    // `exec` redirections apply from the moment it ran, so they sit among the block redirections where it was.
    const exec = this._execOutputs
    const blocks = this._statementOutputs
    const levels: Array<{ level: { redirections: Redirection[], truncated: Set<number> }, block: number }> = blocks.map((level, block) => ({ level, block }))
    if (exec) levels.splice(Math.min(exec.after, blocks.length), 0, { level: exec, block: -1 })
    const floor = this._heldFloor[this._heldFloor.length - 1]
    for (const { level, block } of levels) {
      // `exec` counts as below every floor.
      const outsideHeldPipe = floor !== undefined && (block < 0 || block < floor)
      for (const redirection of level.redirections) {
        if (outsideHeldPipe && redirection.fd === 1) continue
        // A stage before the last has its stdout on the pipe, so the block's redirection of fd 1 is
        // not its to apply (bash applies it to the last stage only). Skipped before the truncation
        // bookkeeping below, or the stage that does own the file would wrongly append.
        if (notLast && redirection.fd === 1) continue
        if (redirection.type !== '>' && redirection.type !== '>|') { inherited.push(redirection); continue }
        if (level.truncated.has(redirection.fd)) inherited.push({ ...redirection, type: '>>' })
        else { inherited.push(redirection); level.truncated.add(redirection.fd) }
      }
    }
    return inherited
  }

  /** Pushes an aggregate command's output redirections for the duration of `run`. */
  private async withStatementOutputs<T>(redirections: readonly Redirection[], run: () => Promise<T>): Promise<T> {
    const outputs = redirections.filter(r => r.fd !== 0 && (r.type === '>' || r.type === '>>' || r.type === '>&'))
    if (outputs.length === 0) return await run()

    this._statementOutputs.push({ redirections: outputs, truncated: new Set() })
    try {
      return await run()
    } finally {
      this._statementOutputs.pop()
    }
  }

  /**
   * Opens a compound statement's trailing redirection (`done < f`) and pushes it; returns a function that pops and
   * closes it, or `undefined` when there is none.
   */
  private async pushStatementStdin(redirections: readonly Redirection[]): Promise<(() => Promise<void>) | undefined> {
    const input = redirections.findLast(r => r.fd === 0 && (r.type === '<' || r.type === '<<' || r.type === '<<<'))
    if (!input) return undefined

    const source = new StdinSource(await this.buildInputStream(input))
    this._stdinSources.push(source)
    return async () => {
      this._stdinSources.pop()
      await source.close()
    }
  }

  /**
   * The shell's own diagnostics (`set -x` traces, refused assignments, command not found). They follow an enclosing
   * `2>file` the way a command's stderr does, and go to the terminal otherwise.
   */
  private async shellDiagnostic(text: string, raw = false): Promise<void> {
    const redirects = (level: { redirections: Redirection[] }) => level.redirections.some(r => r.fd === 2)
    const redirected = (this._execOutputs && redirects(this._execOutputs)) || this._statementOutputs.some(redirects)
    if (!redirected) {
      const io = this.terminalBuiltinIO()
      if (raw) await io.writeErr(text + '\r\n')
      else await io.writelnErr(text)
      return
    }
    const wanted = this.inheritedOutputRedirections(false).filter(r => r.fd === 2)
    const { stderr } = await this.buildOutputStreams(wanted, true, undefined)
    const writer = stderr.getWriter()
    try { await writer.write(new TextEncoder().encode((raw ? '' : this.diagnosticPrefix()) + text + '\n')) } finally {
      try { await writer.close() } catch { writer.releaseLock() }
    }
  }

  /** What the shell's own messages start with: `ecmaos:`, or `./script: line N:` while a script file runs, as bash does. */
  diagnosticPrefix(): string {
    const file = this.state.currentSourceFile()
    return file ? `${file}: line ${this.state.lineNumber}: ` : DIAGNOSTIC_PREFIX
  }

  private terminalBuiltinIO(): ShellBuiltinIO {
    const kernelShell = this
    const terminal = this._terminal
    return {
      stdoutIsTTY: true,
      canTimeout: true,
      get stdinIsTTY() { return kernelShell.currentStdin === undefined },
      write: async (text: string) => { terminal.write(text) },
      writeln: async (text: string) => { terminal.writeln(text) },
      writeErr: async (text: string) => { terminal.write(`\x1b[31m${text}\x1b[0m`) },
      writelnErr: async (text: string) => { terminal.write(`\x1b[31m${kernelShell.diagnosticPrefix()}${text}\x1b[0m\r\n`) },
      readLine: async (options?: ReadLineOptions) => {
        if (options?.fd) return await kernelShell._inputFds.get(options.fd)?.readLine(options)
        const source = this.currentStdin
        if (source) return await source.readLine(options)
        return await terminal.readline(options?.prompt ?? '', options?.silent ?? false, true)
      },
      readAll: async () => {
        const source = this.currentStdin
        if (source) return await source.readAll()
        return await terminal.readline('', false, true)
      },
      close: async () => {}
    }
  }

  /**
   * A redirected or piped builtin's fds, over the streams `buildOutputStreams` gives other commands. Writers are
   * acquired lazily; `close()` releases them once.
   */
  private streamBuiltinIO(
    stdin: ReadableStream<Uint8Array> | StdinSource | undefined,
    stdinIsTTY: boolean,
    stdout: WritableStream<Uint8Array>,
    stdoutIsTTY: boolean,
    stderr: WritableStream<Uint8Array>
  ): ShellBuiltinIO {
    const encoder = new TextEncoder()
    let outWriter: WritableStreamDefaultWriter<Uint8Array> | undefined
    let errWriter: WritableStreamDefaultWriter<Uint8Array> | undefined
    // An already-shared source is used as-is; only a raw stream gets a buffer of its own.
    const source = stdin instanceof StdinSource ? stdin : stdin ? new StdinSource(stdin) : undefined

    // A reader that has already finished (`export -p | jobs`) is not an error for a builtin: what it would
    // have written has nowhere to go, as when SIGPIPE ends a program writing into a closed pipe.
    let outBroken = false
    let errBroken = false
    const out = async (text: string) => {
      if (outBroken) return
      outWriter ??= stdout.getWriter()
      try { await outWriter.write(printfBytes(text)) } catch (error) {
        if ((error as { code?: string })?.code !== 'EPIPE') throw error
        outBroken = true
      }
    }
    const err = async (text: string) => {
      if (errBroken) return
      errWriter ??= stderr.getWriter()
      try { await errWriter.write(encoder.encode(text)) } catch (error) {
        if ((error as { code?: string })?.code !== 'EPIPE') throw error
        errBroken = true
      }
    }

    return {
      stdoutIsTTY,
      stdinIsTTY,
      canTimeout: true,
      write: out,
      writeln: async (text: string) => await out(text + '\n'),
      writeErr: err,
      writelnErr: async (text: string) => await err(`${this.diagnosticPrefix()}${text}\n`),
      readLine: async (options?: ReadLineOptions) => options?.fd ? await this._inputFds.get(options.fd)?.readLine(options) : await source?.readLine(options),
      readAll: async () => await source?.readAll() ?? '',
      close: async () => {
        // Releasing rather than closing on failure: the pipe's far end and the terminal are shared,
        // and `runPipelineStages` owns their lifetime as it does for an execve'd stage.
        try { await outWriter?.close() } catch { outWriter?.releaseLock() }
        try { await errWriter?.close() } catch { errWriter?.releaseLock() }
      }
    }
  }

  private createTerminalOutputStream(): WritableStream<Uint8Array> {
    const writer = this._terminalWriter
    return new WritableStream({
      write: async (chunk) => {
        if (writer) await writer.write(chunk)
      }
    })
  }

  private createTerminalErrorStream(): WritableStream<Uint8Array> {
    const terminal = this._terminal
    return new WritableStream({
      write: async (chunk) => {
        // Write to terminal with error styling
        const text = new TextDecoder().decode(chunk)
        terminal.write(`\x1b[31m${text}\x1b[0m`)
      }
    })
  }

  /** Two WritableStreams that write to the same file, for `&>` and `2>&1`. */
  private createSharedFileStreams(filePath: string, append: boolean): { stdout: WritableStream<Uint8Array>, stderr: WritableStream<Uint8Array> } {
    const context = this.context
    // Use a queue to serialize writes from both streams
    let writeQueue = Promise.resolve()
    let isFirstWrite = true
    
    const writeToFile = async (chunk: Uint8Array) => {
      if (append || !isFirstWrite) {
        await context.fs.promises.appendFile(filePath, chunk)
      } else {
        await context.fs.promises.writeFile(filePath, chunk)
        isFirstWrite = false
      }
    }
    
    const createStream = () => new WritableStream<Uint8Array>({
      write: async (chunk) => {
        // Queue writes to ensure serialization
        const currentWrite = writeQueue.then(() => writeToFile(chunk))
        writeQueue = currentWrite.catch(() => {})
        await currentWrite
      }
    })
    
    const pair = { stdout: createStream(), stderr: createStream() }
    pairStreams(pair.stdout, pair.stderr)
    return pair
  }

  /**
   * Substitutes aliases at each command position (line start and after a top-level `;`, `&`, `|`, `&&`, `||`). Runs
   * once per statement. Substitution repeats on the result without re-substituting a name, and a value ending in a
   * space makes the next word eligible. An alias whose value is control flow is not recognized, since this runs after
   * parsing.
   */
  private expandAliases(line: string): string {
    if (this._aliases.size === 0 || !line) return line

    const expandSegment = (text: string, seen: ReadonlySet<string>): string => {
      const leading = text.length - text.trimStart().length
      const rest = text.slice(leading)
      const name = /^[^\s;&|<>()]+/.exec(rest)?.[0]
      if (!name || seen.has(name)) return text

      const value = this._aliases.get(name)
      if (value === undefined) return text

      const tail = rest.slice(name.length)
      const next = new Set(seen).add(name)
      // A trailing space in the value makes whatever follows eligible in turn.
      const expandedTail = value.endsWith(' ') ? expandSegment(tail, next) : tail
      return text.slice(0, leading) + expandSegment(value.trimEnd(), next) + (value.endsWith(' ') ? expandedTail : tail)
    }

    let out = ''
    let remaining = line
    for (;;) {
      const index = findTopLevelOperatorIndex(remaining)
      if (index === -1) return out + expandSegment(remaining, new Set())

      const pair = remaining.slice(index, index + 2)
      const operator = pair === '&&' || pair === '||' ? pair : (remaining[index] as string)
      out += expandSegment(remaining.slice(0, index), new Set()) + operator
      remaining = remaining.slice(index + operator.length)
    }
  }

  /**
   * How a command name resolves, for `type` and `command -v`: alias, keyword, builtin, function or `$PATH` file, in
   * that order.
   */
  async describeCommand(name: string): Promise<{ kind: 'alias' | 'keyword' | 'builtin' | 'function' | 'file', path?: string } | undefined> {
    if (this._aliases.has(name)) return { kind: 'alias' }
    if (CONTROL_FLOW_KEYWORDS.has(name)) return { kind: 'keyword' }
    if (trueBuiltinNameFor(name)) return { kind: 'builtin' }
    if (this._functions.has(name)) return { kind: 'function' }
    const resolved = await this.resolveCommand(name)
    return resolved ? { kind: 'file', path: resolved } : undefined
  }

  /**
   * Resolves a command to its absolute path
   */
  private async resolveCommand(command: string): Promise<string | undefined> {
    if (command.startsWith('./')) {
      const cwdCommand = path.join(this.cwd, command.slice(2))
      if (await this.context.fs.promises.exists(cwdCommand)) {
        return cwdCommand
      }
      return undefined
    }

    const paths = this.env.get('PATH')?.split(':') || DefaultShellPath.split(':')
    const resolvedCommand = path.resolve(command)

    if (await this.context.fs.promises.exists(resolvedCommand)) {
      return resolvedCommand
    }

    for (const path of paths) {
      const expandedPath = path.replace(/\$([A-Z_]+)/g, (_, name) => this.env.get(name) || '')
      const fullPath = `${expandedPath}/${command}`
      if (await this.context.fs.promises.exists(fullPath)) return fullPath
    }

    return undefined
  }

  /**
   * Sets positional parameters
   */
  setPositionalParameters(args: string[]) {
    this.clearPositionalParameters()
    for (const [index, arg] of args.entries()) this.env.set(`${index}`, arg)
  }

  /** `$1`, `$2`, ... in order, up to the first gap; `$0` is excluded. */
  get positionalParameters(): string[] {
    const values: string[] = []
    for (let i = 1; ; i++) {
      const value = this.env.get(String(i))
      if (value === undefined) break
      values.push(value)
    }
    return values
  }
}



/**
 * Default configuration values
 */
export const DefaultConfig: ITerminalConfig = {
  noBell: false,
  fontFamily: 'FiraCode Nerd Font Mono, Ubuntu Mono, courier-new, courier, monospace',
  fontSize: 16,
  cursorBlink: true,
  cursorStyle: 'block',
  theme: {
    background: '#000000',
    foreground: '#00FF00',
    promptColor: 'green'
  },
  smoothScrollDuration: 100,
  macOptionIsMeta: true,
  renderer: 'webgl'
}

export class TerminalConfig implements ITerminalConfig {
  private _noBell: boolean = DefaultConfig.noBell! // Bang because we know default exists
  private _fontFamily: string = DefaultConfig.fontFamily!
  private _fontSize: number = DefaultConfig.fontSize!
  private _cursorBlink: boolean = DefaultConfig.cursorBlink!
  private _cursorStyle: 'block' | 'underline' | 'bar' = DefaultConfig.cursorStyle!
  private _theme: ITerminalConfig['theme'] = { ...DefaultConfig.theme }
  private _smoothScrollDuration: number = DefaultConfig.smoothScrollDuration!
  private _macOptionIsMeta: boolean = DefaultConfig.macOptionIsMeta!
  private _renderer: 'dom' | 'webgl' = DefaultConfig.renderer!

  private _shell: Shell

  get noBell() { return this._noBell }
  get fontFamily() { return this._fontFamily }
  get fontSize() { return this._fontSize }
  get cursorBlink() { return this._cursorBlink }
  get cursorStyle() { return this._cursorStyle }
  get theme() { return this._theme }
  get smoothScrollDuration() { return this._smoothScrollDuration }
  get macOptionIsMeta() { return this._macOptionIsMeta }
  get renderer() { return this._renderer }

  constructor(shell: Shell) {
    this._shell = shell
  }

  /**
   * Applies a partial configuration to the current config
   */
  private applyConfig(config: Partial<ITerminalConfig>) {
    if (typeof config.noBell === 'boolean') this._noBell = config.noBell
    if (typeof config.fontFamily === 'string') this._fontFamily = config.fontFamily
    if (typeof config.fontSize === 'number') this._fontSize = config.fontSize
    if (typeof config.cursorBlink === 'boolean') this._cursorBlink = config.cursorBlink
    if (['block', 'underline', 'bar'].includes(config.cursorStyle as string)) this._cursorStyle = config.cursorStyle as 'block' | 'underline' | 'bar'
    if (typeof config.smoothScrollDuration === 'number') this._smoothScrollDuration = config.smoothScrollDuration
    if (typeof config.macOptionIsMeta === 'boolean') this._macOptionIsMeta = config.macOptionIsMeta
    if (config.renderer === 'dom' || config.renderer === 'webgl') this._renderer = config.renderer
    if (config.theme) {
      if (config.theme.name && ThemePresets[config.theme.name]) {
        this._theme = { ...this._theme, ...ThemePresets[config.theme.name] }
      } else {
        this._theme = { ...this._theme, ...config.theme }
      }
    }
  }

  /** Loads system-wide configuration from `/etc/terminal.toml`. */
  async loadSystemConfig() {
    try {
      if (await this._shell.context.fs.promises.exists('/etc/terminal.toml')) {
        const content = await this._shell.context.fs.promises.readFile('/etc/terminal.toml', 'utf-8')
        const config = parse(content) as Partial<ITerminalConfig>
        this.applyConfig(config)
      }
    } catch (error) {
      console.warn('Failed to load system terminal config:', error)
    }
  }

  /**
   * Loads configuration from /etc/terminal.toml and ~/.config/terminal.toml
   */
  async load() {
    // Load system default config first
    await this.loadSystemConfig()

    // Load user config second (overwrites system defaults)
    try {
      const home = this._shell.env.get('HOME')
      if (home) {
        const configPath = `${home}/.config/terminal.toml`
        if (await this._shell.context.fs.promises.exists(configPath)) {
          const content = await this._shell.context.fs.promises.readFile(configPath, 'utf-8')
          const config = parse(content) as Partial<ITerminalConfig>
          this.applyConfig(config)
        }
      }
    } catch (error) {
      console.warn('Failed to load user terminal config:', error)
    }
  }

  setTheme(theme: string | ITerminalConfig['theme']) {
    if (typeof theme === 'string') {
      if (Object.prototype.hasOwnProperty.call(ThemePresets, theme)) {
        const preset = ThemePresets[theme]
        this._theme = { ...this._theme, ...preset }
        if (this._theme) {
          this._theme.name = theme
        }
      }
    } else {
      this._theme = { ...this._theme, ...theme }
    }
    
    this._shell.terminal.updateConfig()
  }
}
