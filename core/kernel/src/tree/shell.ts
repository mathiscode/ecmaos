/**
  * @experimental
  * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
  * 
  * The Shell class handles the Terminal environment and interaction with the Kernel.
  * 
 */

import path from 'path'
import { parse } from 'smol-toml'
import { bindContext } from '@zenfs/core'
import type { BoundContext, Credentials } from '@zenfs/core'
import { fromDev, Process as ZenFSProcess, Signal } from '@zenfs/linux'
import type {
  Filesystem, Job, JobProcessHandle, JobStatus, KernelContext,
  Shell as IShell, ShellBuiltinIO, ShellCreatePipeStream, ShellExecute, ShellOptionName, ShellOptions, TerminalConfig as ITerminalConfig, Terminal as ITerminal, Users
} from '@ecmaos/types' // TODO: Consistency
import { ThemePresets } from '@ecmaos/types'

import type { ReadLineOptions } from '@ecmaos/coreutils/lib/shell-core/builtins'
import { parseRedirections, stripComments, tokenize, tokenizeConditional } from '@ecmaos/coreutils/lib/shell-parser'
import type { Command as ParsedCommand, Pipeline, Redirection, WordPart } from '@ecmaos/coreutils/lib/shell-parser'
import { CONTROL_FLOW_KEYWORDS, parseStatements } from '@ecmaos/coreutils/lib/control-flow-parser'
import type { Redirected, Statement } from '@ecmaos/coreutils/lib/control-flow-parser'
import { expandWord, evaluateArithmeticExpression } from '@ecmaos/coreutils/lib/expand-variables'
import { aggregateBuiltinNames, jobStatusLabel, runTrueBuiltin, trueBuiltinNameFor } from '#lib/shell-builtins.ts'
import { SessionLog } from '#lib/sessions.ts'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from '@ecmaos/coreutils/lib/shell-core/signals'
import { ShellState } from '@ecmaos/coreutils/lib/shell-core/state'
import { Interpreter, type InterpreterHost } from '@ecmaos/coreutils/lib/shell-core/interpreter'
import { parseArrayAssignment, splitAssignments, type Assignment } from '@ecmaos/coreutils/lib/shell-core/prepare'
import { expandWordFieldsBraced, expandWordString, expandHeredocBody, type ExpansionContext } from '@ecmaos/coreutils/lib/word-expansion'
import { evaluateConditional, type ConditionalFs } from '@ecmaos/coreutils/lib/conditional-eval'

/**
 * The one shell whose exported environment `globalThis.process.env` currently mirrors.
 *
 * `process.env` is a single global object and ecmaOS runs up to eight shells at once, one per virtual
 * console. Every shell used to write to it directly, so two TTYs clobbered each other's `$PATH` and
 * whichever logged in last won. It is a compatibility mirror for code written against Node, not a
 * source of truth -- each shell's own `Map` is -- so exactly one shell publishes to it: the one whose
 * TTY is active. `Kernel.switchTty` hands ownership over as consoles switch, the way `/proc/self`
 * follows the current process rather than being shared between them.
 */
let processEnvOwner: object | undefined

/**
 * Names that live in a shell's environment `Map` for lookup's sake but are the shell's own state and
 * must never reach a child process: `$?`, the positional parameters (`$0`, `$1`, ...), and the other
 * one-character specials. A real shell keeps these out of the environment entirely -- `execve` passes
 * `envp`, and `1=arg` is not an environment variable.
 *
 * Known limit: this is the boundary in the *other* direction only. A bare `X=1` still reaches a child
 * here, where bash requires `export X` first, because ecmaOS has no exported-flag store yet and every
 * `shell.env.set` call site would have to declare its intent.
 */

/**
 * Finds the first top-level (unquoted, unescaped, not nested inside `$(...)`/`$((...))`)
 * `;`/`&`/`|` in `text`, for splitting a bare `VAR=value` assignment from whatever statement
 * follows it on the same line (`tryExecuteAssignment`). Deliberately simpler than
 * `shell-parser.ts`'s `tokenize` -- it doesn't word-split on whitespace, so `$((X + 3))` survives
 * intact inside an assignment's value the same way it already does today. Returns -1 if none found.
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

/** Tokenizes `text` as a single word (for `a[i]=value`'s right-hand side) and returns its parts. */
function tokenizeSingleWord(text: string): WordPart[] {
  const tokens = tokenize(text)
  return tokens.length === 1 && tokens[0]?.kind === 'word' ? (tokens[0].parts ?? []) : [{ text, quoting: 'unquoted' }]
}

/**
 * Whether reading this character device yields end-of-file immediately.
 *
 * Only `/dev/null` does, and on Linux it is device 1:3 -- the same numbers `@zenfs/linux` gives it
 * (`memMajor` is 1, null is minor 3). `/dev/zero`, `/dev/full`, `/dev/random` and `/dev/urandom` all
 * produce data endlessly, and a tty blocks, so none of them belong here.
 *
 * This exists because the filesystem layer cannot express EOF for a device at all: `DeviceFS.read`
 * discards whatever the driver did, and `@zenfs/core`'s `vfs/file.js` returns the full requested
 * length for a character device by design. Fixing that upstream would let this go away.
 */
function readsAsEof(rdev: number): boolean {
  const { major, minor } = fromDev(rdev)
  return major === 1 && minor === 3
}

/**
 * A line-oriented, *shared* view of one input stream.
 *
 * The point is that the buffer outlives a single read. `while read -r line; do ...; done < f` opens
 * `f` once and every `read` in the body advances through the same source, so a chunk that happened
 * to span a line boundary is not lost between iterations. A fresh reader per `read` would drop it.
 *
 * Only builtins read it. See `runPipelineStages` for why a real command in the same statement
 * cannot be handed this source.
 */
class StdinSource {
  private pending = ''
  private eof = false
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  constructor(private readonly stream: ReadableStream<Uint8Array>) {}

  /** Appends one more chunk to the buffer. False once the stream is exhausted. */
  private async fill(): Promise<boolean> {
    if (this.eof) return false
    this.reader ??= this.stream.getReader()
    const { done, value } = await this.reader.read()
    if (done) { this.eof = true; return false }
    this.pending += new TextDecoder().decode(value)
    return true
  }

  /**
   * The next line without its newline, or `undefined` at EOF. `delimiter` replaces the newline (an
   * empty string is NUL), `count` returns after that many characters, and `result.terminated` says
   * whether one of those ended the read rather than the end of the stream.
   */
  async readLine(options: { delimiter?: string, count?: number, result?: { terminated: boolean } } = {}): Promise<string | undefined> {
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
      if (!await this.fill()) {
        // A final line with no trailing newline is still a line; an empty tail is EOF.
        if (options.result) options.result.terminated = false
        if (this.pending === '') return undefined
        const line = this.pending
        this.pending = ''
        return line
      }
    }
  }

  /**
   * Everything buffered, or the next chunk when nothing is: what a real command is handed as its
   * stdin. It reads on demand (one chunk per pull), and the command's own kernel bridge returns
   * whatever the command left unread through `unread`, so a body's `cat` and `read` share one
   * position the way processes sharing a file descriptor do.
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


/**
 * A tracked pipeline job. See `@ecmaos/types`' `Job` for the field-by-field contract; this class
 * only adds the bookkeeping `Shell` needs to resolve `done` once every stage settles and to mark
 * itself `done` with the right exit codes exactly once.
 */
class JobImpl implements Job {
  notified?: boolean
  id: number
  commandLine: string
  status: JobStatus = 'running'
  exitCodes?: number[]
  processes: JobProcessHandle[] = []
  background: boolean
  /**
   * Assigned by `Shell.createJob` right after construction, once `runPipeline` has actually been
   * started against this job -- not in the constructor, so `runPipeline` can close over `this` and
   * push process handles onto `processes` as they appear while it's still running.
   */
  done!: Promise<number[]>

  constructor(id: number, commandLine: string, background: boolean) {
    this.id = id
    this.commandLine = commandLine
    this.background = background
  }
}

const DefaultShellPath = '$HOME/bin:/bin:/usr/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin'
/**
 * A command name that resolved to nothing: no builtin, no function, no file on `$PATH`.
 *
 * Its own type because `runPipeline` has to tell it apart from a genuine error thrown while a
 * command was being prepared. A missing command fails that one command with exit 127 and lets the
 * script continue, as in bash; anything else still unwinds.
 */
/** What the shell itself puts before a diagnostic, as `ecmash` does with its own name: `<name>: <message>`. */
const DIAGNOSTIC_PREFIX = 'ecmaos: '

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
  private _ctx: KernelContext
  private _cwd: string
  private _execute: ShellExecute
  private _filesystem: Filesystem
  private _id: string = crypto.randomUUID()
  private _terminal: ITerminal
  private _terminalWriter?: WritableStreamDefaultWriter<Uint8Array>
  private _tty: number
  private _users: Users

  /**
   * `local` overlays pushed per function call: each frame is checked before falling through to
   * `_env` on read, and `local NAME=VALUE` writes only ever touch the top frame. Empty outside a
   * function call, so top-level `env.get`/`env.set` behavior is completely unchanged by this.
   */
  /**
   * Inputs opened by a redirected compound statement (`while ...; done < f`), innermost last.
   *
   * The top of this stack is what `read` and a first-stage command read from when they have no
   * redirection of their own, instead of the terminal. Held as a stack so nested loops each read
   * from their own input and restore the outer one on the way out.
   */
  private _stdinSources: StdinSource[] = []
  /**
   * Each active aggregate builtin (`eval`, `source`, ...) that feeds a pipe, as a factory for a
   * non-closing view of that pipe. The commands it runs write their stdout through one of these, so
   * `eval 'echo x' | grep x` reaches `grep`; the pipe itself is closed once, by the builtin's stage.
   */
  private _heldStdout: Array<() => WritableStream<Uint8Array>> = []

  /**
   * Output redirections belonging to an enclosing *aggregate* command -- a redirected compound
   * statement (`done > f`), a redirected function call (`greet > f`), or `eval`/`source` with a
   * redirection. Outermost first.
   *
   * None of those three have a single command whose fds could carry the redirection, because each
   * runs a whole statement tree whose commands build their own streams. So the redirection is kept
   * here and consulted by `buildOutputStreams`, where a command with no redirection of its own
   * inherits it instead of defaulting to the terminal. Without this the redirection parsed and was
   * then silently discarded -- the same bug `done < f` had on the input side.
   *
   * `truncated` is what keeps `> f` from truncating once per command in the body: the first command
   * to write to that fd truncates, every later one appends, which is what one shared descriptor
   * would do.
   */
  private _statementOutputs: Array<{ redirections: Redirection[], truncated: Set<number> }> = []

  /**
   * Output redirections installed by `exec > file`, which apply to the shell itself rather than to
   * one command.
   *
   * Kept apart from `_statementOutputs` because it is not a stack: it has no matching pop, outliving
   * every statement until another `exec` replaces it. `inheritedOutputRedirections` reads it as the
   * outermost layer, so a command's own redirection and any enclosing statement's both still win.
   */
  private _execOutputs?: { redirections: Redirection[], truncated: Set<number> }

  /**
   * All jobs this shell has ever launched, insertion order (oldest first), keyed by job number.
   * Entries are never removed automatically -- `jobs` in a real shell keeps showing a `Done` job
   * until the next prompt reaps it; this implementation just keeps it, which `listJobs()` callers
   * (the `jobs` coreutil) can filter/trim for display if that behavior is ever wanted.
   */
  private _jobs: JobImpl[] = []
  private _nextJobId = 1
  /**
   * The job currently occupying the foreground, if any. Simplified single-foreground-process model:
   * `@zenfs/linux` has no process-group concept, so this is one `Job` reference, not a real pgid.
   * Set when a pipeline starts running in the foreground (`execute()`'s non-`&` path), cleared when
   * it finishes; a job moved to the background (via trailing `&`, or `bg`) is never foreground here.
   */
  private _foregroundJob: Job | undefined

  /**
   * Set when a foreground process was killed by `SIGINT`, so the rest of a `;`/`&&`/`||` list and
   * any enclosing loop stop instead of carrying on. bash aborts the whole list on `^C`; before this
   * existed, `echo a; sleep 25; echo b` still printed `b` after the `^C` that killed the sleep.
   *
   * Cleared at the start of every `execute()`, so it only ever describes the line running now.
   */
  private _interrupted = false

  /**
   * How many `execute()` calls are currently on the stack. Only the outermost one clears
   * `_interrupted`: a trap handler, a command substitution and a function body all run through
   * `execute()` too, so resetting unconditionally meant `runTrap('INT')` wiped the very flag that
   * dispatched it, and the rest of the interrupted line carried on regardless.
   */
  private _executeDepth = 0

  /**
   * How many frames are currently on the stack that will catch each kind of control-flow signal
   * (see `@ecmaos/coreutils/lib/shell-core/signals`): a script or sourced file for `exit`, a function call or sourced
   * file for `return`, an enclosing loop for `break`/`continue`.
   *
   * `execute()`'s outermost frame is the last-resort handler for all three, and it needs to know
   * whether some frame *above* it is going to handle the signal instead. Nesting depth alone cannot
   * answer that: a loop condition and the `env` builtin both call `execute()` recursively, so an
   * `exit` inside a script can be one `execute()` frame deep or five, while the script's own
   * handler sits outside `execute()` entirely (`executeScriptText` walks `executeStatements`
   * directly). Counting the real handlers is exact where counting depth is a guess.
   */
  private get _signalCatchers() { return this.interpreter.catchers }

  /**
   * A real, registered `@zenfs/linux` `Process` standing for this shell, created on first use.
   *
   * `$$` and `$PPID` have to come from somewhere, and inventing a number would eventually collide
   * with a real pid -- ecmaOS allocates pids from `@zenfs/linux`'s own table, so the only way to get
   * one that is genuinely the shell's is to take one from that table. The process is registered and
   * never exits, which is correct: a shell is a process, and Linux's `ps` shows it. Its standard
   * descriptors go to `/dev/null` rather than the console, the same choice `Kernel.pipeProcess`
   * makes, so holding it costs nothing and touches no terminal.
   *
   * When `/bin/ecmash` becomes a real program this stops being a stand-in and starts being the
   * shell's actual process.
   */
  private _process?: InstanceType<typeof ZenFSProcess>

  /**
   * The language state: variables, arrays, `local` frames, `readonly`, functions, aliases, traps and
   * `set` options, shared with `/bin/ecmash`. The underscore names below are views onto it, so the
   * rest of this class reads as it always did.
   */
  readonly state = new ShellState({ pid: () => this.process.pid, ppid: () => this.process.ppid })

  /** The shared statement walk. This shell supplies how a pipeline runs (see {@link hostInterface}). */
  readonly interpreter = new Interpreter(this.hostInterface(), this.state)
  private get _env(): Map<string, string> { return this.state.vars }
  private set _env(vars: Map<string, string>) { this.state.adopt(vars) }
  private get _functions() { return this.state.functions }
  private set _functions(functions: Map<string, Statement[]>) { this.state.functions = functions }
  private get _aliases() { return this.state.aliases }
  private get _shellOptions() { return this.state.options }
  private get _arrays() { return this.state.arrays }
  private set _arrays(arrays: Map<string, Map<number, string>>) { this.state.arrays = arrays }
  private get _lastBackgroundPid() { return this.state.lastBackgroundPid }
  private set _lastBackgroundPid(pid: number | undefined) { this.state.lastBackgroundPid = pid }

  public readonly config: TerminalConfig

  public credentials: Credentials = { uid: 0, gid: 0, suid: 0, sgid: 0, euid: 0, egid: 0, groups: [] }
  public context: BoundContext = bindContext({ root: '/', pwd: '/', credentials: this.credentials })

  get cwd() { return this._cwd }
  /**
   * Setting the working directory also maintains `PWD` and `OLDPWD`, the way every real shell does.
   * They are ordinary environment variables, not a second source of truth: `_cwd` stays
   * authoritative and these are written from it, so `$PWD` can never disagree with `pwd`. Without
   * this, `echo $PWD` expanded to nothing and `cd -` had nothing to return to.
   */
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
   * This shell's environment as a plain object: what every child process receives as its `envp`, and
   * what `globalThis.process.env` mirrors.
   *
   * Shell-internal state is filtered out (see {@link SHELL_ONLY_VARIABLES}). It used to be handed
   * over wholesale, so every command started with `?=0` in its environment and a script's positional
   * parameters arrived as `0=/bin/foo`, `1=arg`.
   */
  get envObject() {
    return this.state.environment()
  }

  /**
   * Publishes this shell's exported environment to `globalThis.process.env`, if this shell is the one
   * that owns that mirror. A no-op for every other shell, which is what keeps eight virtual consoles
   * from overwriting each other. See {@link processEnvOwner}.
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
   * Records that a foreground process was interrupted, and runs any `trap ... INT` handler.
   *
   * This is the only path by which an interactive `^C` reaches the shell's trap table. While a
   * foreground `execve`'d process holds the terminal, `Terminal.keyHandler` returns early
   * (`if (this._ttyInput) return` -- the line discipline owns the keyboard) and the keystroke is
   * turned into a real `SIGINT` by `ISIG` instead. So the `runTrap('INT')` call in that key handler
   * never fires for exactly the case an `INT` trap is written for; `Kernel.executeViaExecve` calls
   * this when it observes `proc.killed_by === Signal.INT`, where the signal actually lands.
   */
  async notifyInterrupted(): Promise<void> {
    // Handler first, flag second. The handler runs through `execute()` like any other command, so
    // if the flag were already set, a multi-command handler (`trap 'echo a; echo b' INT`) would
    // abort after its first stage on the very check this flag exists to drive.
    await this.runTrap('INT')
    this._interrupted = true
  }
  /** The real user registry -- needed by `su` (a true shell builtin, see `lib/shell-builtins.ts`). */
  get users() { return this._users }

  /** Files this console's login in `/run/utmp` and `/var/log/wtmp`. A failure to record is never a failure to log in. */
  async recordLogin(username: string): Promise<void> {
    try {
      this._sessions ??= new SessionLog(this._filesystem.fs)
      await this._sessions.login(username, this._tty)
    } catch { /* the login itself already succeeded */ }
  }
  private _sessions?: SessionLog
  /** Translated strings -- needed by `su`'s error messages, the same way `resolveCommand` uses it. */
  get i18n() { return this._ctx.i18n }

  /**
   * Resolve a variable by name the way `local` scoping requires: the innermost active function
   * frame first, falling through to the shell's real environment. This is what `expandWord`'s
   * `lookup` is bound to everywhere a word is expanded, so `local`-declared variables shadow outer
   * ones exactly where a real shell would.
   */
  lookupVariable(name: string): string | undefined {
    return this.state.lookup(name)
  }

  /** `getopts`'s position within the argument it is currently reading. See {@link _getoptsCharIndex}. */
  get getoptsCharIndex(): number { return this.state.getoptsCharIndex }
  set getoptsCharIndex(index: number) { this.state.getoptsCharIndex = index }

  /**
   * This shell's own `@zenfs/linux` process, created on first use. See {@link _process}.
   *
   * Created lazily rather than in the constructor because a `Process` opens its standard descriptors
   * immediately, and a `Shell` is constructed before `Kernel.boot` has mounted `/dev`. Nothing reads
   * `$$` that early, so by the time this runs the device is there.
   */
  get process(): InstanceType<typeof ZenFSProcess> {
    this._process ??= new ZenFSProcess({ argv: ['ecmash'], cwd: this._cwd, console: '/dev/null' })
    return this._process
  }

  /** Whether `name` was marked `readonly`, so an assignment or an unset must be refused. */
  isReadonly(name: string): boolean { return this.state.isReadonly(name) }

  /** Marks `name` readonly. There is deliberately no way back, as in bash. */
  markReadonly(name: string): void { this.state.markReadonly(name) }

  /** Every readonly name, for `readonly -p`. */
  readonlyNames(): string[] { return [...this.state.readonlyNames].sort() }

  /**
   * `set NAME=VALUE`: writes to the innermost `local` frame if one is active, else the real env.
   * @throws when `name` was marked `readonly`
   */
  setVariable(name: string, value: string, append = false): void {
    this.state.set(name, value, append)
    this.publishEnv()
  }

  /**
   * Every variable visible right now, `local` frames layered over the environment, with the shell's
   * own internal names left out (see {@link SHELL_ONLY_VARIABLES}).
   *
   * This is what `export -p` and bare `env` list. Reading `env` directly missed anything a `local`
   * declaration was shadowing, so inside a function those two printed the caller's values.
   */
  visibleVariables(): Map<string, string> {
    return this.state.visibleVariables()
  }

  /**
   * Indexed arrays -- `arrays` for `word-expansion.ts`'s `lookupArray`, and direct mutators for
   * `=(...)`, `a[i]=`, `unset a[i]`, `a+=(...)`.
   *
   * Every one of these honors `local`: a name declared local in an active frame is read and written
   * there, and the shell-global `_arrays` is only reached when no frame declares it.
   */
  get arrays(): Map<string, Map<number, string>> {
    return this.state.visibleArrays()
  }

  /** Reads `name`'s array from the innermost frame that declares it, else from the shell's own. */
  lookupArray(name: string): Map<number, string> | undefined {
    return this.state.lookupArray(name)
  }

  setArray(name: string, values: string[]): void { this.state.setArray(name, values) }
  setArrayElement(name: string, index: number, value: string): void { this.state.setArrayElement(name, index, value) }
  appendArray(name: string, values: string[]): void { this.state.appendArray(name, values) }
  unsetArrayElement(name: string, index: number): void { this.state.unsetArrayElement(name, index) }
  unsetArray(name: string): void { this.state.unsetArray(name) }

  /**
   * `trap 'cmd' SIG`/`trap - SIG`/`trap '' SIG`/bare `trap`. Signal names are normalized (leading
   * `SIG` stripped, uppercased) so `trap ... SIGINT` and `trap ... INT` register the same handler.
   */
  setTrap(handler: string | undefined, signal: string): void { this.state.setTrap(handler, signal) }
  getTrap(signal: string): string | undefined { return this.state.getTrap(signal) }
  listTraps(): Array<[string, string]> { return this.state.listTraps() }

  /** Runs the handler registered for `signal`, if any (and it isn't the `''` ignore marker). Errors from the handler are swallowed -- a bad trap must not crash the shell. */
  async runTrap(signal: string): Promise<void> {
    const handler = this.getTrap(signal)
    if (!handler) return
    try { await this.execute(handler) } catch {}
  }

  /**
   * Builds a `word-expansion.ts` `ExpansionContext` bound to this shell's current variable/array/
   * positional-parameter state, for `[[ ]]`, heredocs, and any other new construct that needs the
   * quote-aware expander rather than the older string-based `expandWord` path.
   */
  expansionContext(): ExpansionContext {
    return {
      lookup: (name) => this.lookupVariable(name),
      lookupArray: (name) => this.lookupArray(name),
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
      nounset: this._shellOptions.nounset
    }
  }

  /** Declare `name` as local to the current function call, defaulting to '' until assigned. */
  declareLocal(name: string, value?: string): void { this.state.declareLocal(name, value) }

  /** Apply a `set` flag. See {@link _shellOptions} for what each one does. */
  applyShellOption(flag: ShellOptionName, enabled: boolean): void { this.state.setOption(flag, enabled) }

  /**
   * `set -x` -- writes `$PS4` followed by the command about to run to stderr.
   *
   * The arguments are the expanded ones, which is the point: xtrace exists to show what a command
   * actually received after the shell was done with it, not what was typed.
   */
  private async trace(args: readonly string[]): Promise<void> {
    if (!this._shellOptions.xtrace || args.length === 0) return
    const ps4 = this.lookupVariable('PS4') ?? '+ '
    await this.terminalBuiltinIO().writelnErr(ps4 + args.join(' '))
  }

  /** `set -v` -- echoes a line of input to stderr before it runs. */
  private async traceVerbose(line: string): Promise<void> {
    if (!this._shellOptions.verbose || !line) return
    await this.terminalBuiltinIO().writelnErr(line)
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
    this._filesystem = options.filesystem
    this._users = options.users
    this._terminal = options.terminal as ITerminal
    this._terminalWriter = this._terminal?.stdout.getWriter() || new WritableStream().getWriter()
    this.config = new TerminalConfig(this)

    // `_cwd` was assigned directly above, before `_env` existed, so the `cwd` setter that normally
    // maintains `PWD` never ran for the initial value. Seed it here so `$PWD` is correct from the
    // first prompt rather than only after the first `cd`.
    this._env.set('PWD', this._cwd)

    // `$SHLVL` counts shells deep, and unlike `$$`/`$PPID` it is a real environment entry: it only
    // means anything because a child shell inherits it and adds one. Nothing nests shells yet, so
    // every virtual console is level 1; the increment is here so `/bin/ecmash` reports 2 the day it
    // can run inside another shell, with nothing else to change.
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
    } catch {}

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
    } catch {}
  }

  /**
   * Runs the shell startup files, in bash's order: the system-wide ones first, then the user's, so a
   * user file can override what the system set.
   *
   * Two things this deliberately does not do. It does not go through `executeScriptText`, which fires
   * the `EXIT` trap when the text ends -- an rc file that installs a trap wants it to survive for the
   * session, not to run immediately. And it does not stop when one file fails: a broken `~/.ecmashrc`
   * should not cost you a shell, which is why each file is guarded on its own.
   *
   * Login files (`profile`) and per-shell files (`ecmashrc`) run together here because every shell in
   * ecmaOS is a login shell today: each virtual console authenticates, and nothing nests shells yet.
   * When `/bin/ecmash` can run inside another shell, the `profile` half becomes conditional on
   * `argv[0]` starting with a `-` and only the `ecmashrc` half stays unconditional.
   */
  async loadProfile() {
    const home = this._env.get('HOME')
    const candidates = ['/etc/profile']

    // bash reads the *first* of these three that exists, not all of them, so that a `~/.bash_profile`
    // can suppress `~/.profile` rather than adding to it.
    if (home) {
      for (const name of ['.ecmash_profile', '.profile']) {
        const candidate = path.join(home, name)
        try {
          if (await this.context.fs.promises.exists(candidate)) {
            candidates.push(candidate)
            break
          }
        } catch {}
      }
    }

    candidates.push('/etc/ecmashrc')
    if (home) candidates.push(path.join(home, '.ecmashrc'))

    for (const file of candidates) {
      try {
        if (!await this.context.fs.promises.exists(file)) continue
        const content = await this.context.fs.promises.readFile(file, 'utf-8')
        await this.executeSourced(content)
      } catch (error) {
        // `exit` in a startup file stops startup, as in bash -- there is no process to end here, so
        // the remaining files are skipped and the prompt is reached anyway.
        if (error instanceof ExitSignal) break
        try {
          this.terminal?.writeln(`ecmash: ${file}: ${(error as Error).message}`)
        } catch {}
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
        // `value` is `''` for a bare `FOO=`, which is a real assignment of the empty string, not a
        // malformed line: the old `!value` guard dropped it, so a file could not clear an inherited
        // variable. Only a missing key is a reason to skip.
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
      try { this._terminalWriter.releaseLock() } catch {}
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
   * `$(...)`: runs `command` in a subshell with its stdout held on a scratch file, so any amount of
   * output is safe and builtins, functions, pipelines, lists and nested substitutions all work.
   * The substitution's status is kept for `x=$(cmd)`, which reports it as `$?`.
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

  /**
   * Expands tilde (~) to the user's home directory
   * Handles ~, ~/, and ~/path patterns
   * Respects quotes: no expansion inside single quotes, expansion inside double quotes
   */
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

  /**
   * Expands a glob pattern to matching file paths
   * @param pattern - Glob pattern (e.g., "bin/*", "*.js")
   * @returns Array of matching file paths
   */
  private async expandGlob(pattern: string): Promise<string[]> {
    // `set -f`: pathname expansion off, so the pattern stays exactly as written.
    if (this._shellOptions.noglob) return [pattern]

    if (!pattern.includes('*') && !pattern.includes('?')) {
      return [pattern]
    }

    const lastSlashIndex = pattern.lastIndexOf('/')
    const searchDir = lastSlashIndex !== -1
      ? path.resolve(this.cwd, pattern.substring(0, lastSlashIndex + 1))
      : this.cwd
    const globPattern = lastSlashIndex !== -1
      ? pattern.substring(lastSlashIndex + 1)
      : pattern

    try {
      const entries = await this.context.fs.promises.readdir(searchDir)
      const regexPattern = globPattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
      const regex = new RegExp(`^${regexPattern}$`)
      
      const matches = entries.filter(entry => regex.test(entry))
      
      if (lastSlashIndex !== -1) {
        const dirPart = pattern.substring(0, lastSlashIndex + 1)
        return matches.map(match => dirPart + match)
      }
      return matches
    } catch {
      // If directory doesn't exist or can't be read, return empty array
      // This matches standard shell behavior where non-matching globs are passed as-is
      return []
    }
  }

  /**
   * Builds the (fd -> writable stream) map for one pipeline command, following its redirections in
   * order so later ones win — the same left-to-right rule real shells apply (`> f 2>&1` and
   * `2>&1 > f` mean different things, and both are expressible this way).
   *
   * fd 1 and fd 2 default to the terminal (or the pipe, mid-pipeline) when nothing redirects them;
   * any other fd a script names is left for a caller that cares about it — this shell doesn't open
   * arbitrary fds yet.
   *
   */
  private async buildOutputStreams(
    redirections: Redirection[],
    isLastCommand: boolean,
    pipeWritable: WritableStream<Uint8Array> | undefined
  ): Promise<{ stdout: WritableStream<Uint8Array>, stderr: WritableStream<Uint8Array> }> {
    const fdStreams = new Map<number, WritableStream<Uint8Array>>()
    const fdFiles = new Map<number, { path: string, append: boolean }>()


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
            fdStreams.set(redirection.fd, this.createFileWriteStream(sourceFile.path, sourceFile.append))
            fdFiles.set(redirection.fd, sourceFile)
          } else {
            fdStreams.set(redirection.fd, defaultFor(sourceFd))
            fdFiles.delete(redirection.fd)
          }
        }
        continue
      }

      if (redirection.type === '>' || redirection.type === '>>' || redirection.type === '>|') {
        // Expanded, not taken literally: `> /tmp/work.$$` and `> "$dir/out"` have to name the file
        // the script meant. The input side has always done this (`buildInputStream`); the output side
        // used the raw text, so a redirect target containing a variable created a file named after
        // the unexpanded word while every other reference to it expanded normally.
        const targetPath = path.resolve(this.cwd, await this.expandRedirectionTarget(redirection))
        const append = redirection.type === '>>'
        fdStreams.set(redirection.fd, this.createFileWriteStream(targetPath, append))
        fdFiles.set(redirection.fd, { path: targetPath, append })
      }
    }

    // Two fds that both resolved to the same underlying file need one shared, serialized writer,
    // not two independent ones racing each other -- this is what &> and 2>&1 > f actually need.
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
   * Resolves one pipeline stage's words (substitution, history-bang, tilde, variables, arithmetic,
   * glob) into a runnable command. Single-quoted words are exempt from variable/arithmetic
   * expansion the same way they are from globbing (`wordsQuoted`, tracked by the parser) --
   * `echo '$HOME'` must print the literal text, not the expanded path.
   */
  private async prepareCommand(command: ParsedCommand): Promise<{ finalCommand: string, args: string[] }> {
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

    const finalCommand = await this.resolveCommand(commandName)
    if (!finalCommand) {
      throw new CommandNotFoundError(this._ctx.i18n.t('commandNotFound', { ns: 'kernel', command: commandName }))
    }

    return { finalCommand, args }
  }

  /**
   * `set -u`: throws if `original` referenced a plain `$VAR`/`${VAR}` whose name resolves to
   * `undefined`. Only plain references count -- `${VAR:-default}`/`${VAR:+alt}` are explicitly
   * about tolerating an unset variable, so they're exempt, matching bash's own `set -u` semantics.
   */
  private assertNoUnsetReferences(original: string): void {
    const pattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(original))) {
      const name = match[1] ?? match[2]
      if (name && this.lookupVariable(name) === undefined) {
        throw new Error(`${name}: unbound variable`)
      }
    }
  }

  /**
   * Runs one pipeline (`a | b | c`), wiring each stage's stdout to the next's stdin, and returns
   * each stage's exit code in order -- `${PIPESTATUS[@]}`, not "last non-zero wins".
   *
   * @param job - When given, every stage that produces a real `@zenfs/linux` Process (only the
   * `js`/`node` binfmt path today) registers its handle on `job.processes` as soon as it exists,
   * via `onProcess` -- this is how a backgrounded or foregrounded pipeline becomes signalable by
   * `^C`/`^Z`/`fg`/`bg` before it has finished running.
   */
  private async runPipeline(pipeline: Pipeline, job?: JobImpl): Promise<number[]> {
    // Process substitutions expanded for this pipeline's words live until it has finished.
    const mark = this._processSubstitutions.length
    try {
      return await this.runPipelineWithPrefixes(pipeline, job)
    } finally {
      await this.finishProcessSubstitutions(mark)
    }
  }

  /**
   * `<(cmd)` and `>(cmd)`, as bash does when `/dev/fd` is not usable: a path in `/tmp` standing in
   * for the far end of a pipe. A real process would get an fd number into its own table, but a child
   * here inherits only fds 0 to 2, so `/dev/fd/63` would name nothing in it.
   *
   * The trade is that this does not stream. `<(cmd)` runs `cmd` to completion into the file before
   * the command that reads it starts, so an endless producer never yields a path; `>(cmd)` runs
   * after the command that wrote to it has finished, with the file as its stdin. For `diff <(a)
   * <(b)`, `while read l; do ...; done < <(cmd)`, `tee >(a) >(b)` and everything else that reads or
   * writes a finite stream, the result is the same. Removed once the pipeline finishes.
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
    // `>(cmd)` needs the file as *cmd's* stdin. A redirection held over a statement tree reaches only
    // builtins (a real command gets a closed stdin; see the Phase 6 note on a shared fd 0), so the
    // redirection is written into the line instead, on the command that reads first: `< file a | b`.
    // A compound command or a list cannot take one there, and falls back to the held redirection.
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
   * Applies a pipeline's `NAME=VALUE` prefix assignments, returning a function that puts the
   * previous values back.
   *
   * Applied before any of the pipeline's words are expanded, because `IFS=: cmd $x` has to split
   * `$x` by the new IFS, and expanded left to right so `A=1 B=$A cmd` sees `A`.
   *
   * Written through `env` rather than `setVariable` so the values reach a spawned process, which
   * takes its environment from `envObject` -- the same thing the `env` builtin already does.
   *
   * Known limit: every stage's prefixes are applied around the whole pipeline rather than per stage,
   * because the stages start concurrently and share one `env`. `IFS=: a | IFS=, b` is therefore
   * approximate; a single command, which is what `IFS= read` needs, is exact.
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
    /**
     * A stage is either a real command to hand `Kernel.execute`, or a true builtin to run in this
     * shell's own tick. Both get an identically-wired set of fds, which is what lets `jobs > f` and
     * `jobs | grep x` work at all -- a builtin used to bypass this whole method.
     */
    type Stage = {
      args: string[]
      stdin: ReadableStream<Uint8Array> | undefined
      /**
       * Set when this stage's stdin is a redirected compound statement's shared input. A builtin
       * reads it directly: wrapping `asStream()` in a second buffer swallowed the lines that came in
       * the same chunk, so `while read -r line; done < f` only ever saw the first one.
       */
      stdinSource: StdinSource | undefined
      stdinLeftover: ((bytes: Uint8Array) => void) | undefined
      stdinIsTTY: boolean
      stdout: WritableStream<Uint8Array>
      stdoutIsTTY: boolean
      /**
       * Whether this stage's stdout has a final destination (a file, or the terminal) rather than a
       * downstream reader, so the kernel should drain it fully before reporting the exit code. Only
       * the last stage qualifies -- see `KernelExecuteOptions.drainStdout`.
       */
      drainStdout: boolean
      stderr: WritableStream<Uint8Array>
    } & ({ kind: 'command', finalCommand: string } | { kind: 'builtin', name: string, aggregate: readonly Redirection[] | undefined })

    const stages: Stage[] = []

    let prevReadable: ReadableStream<Uint8Array> | undefined

    for (let i = 0; i < commands.length; i++) {
      const command = commands[i] as ParsedCommand
      const isFirstCommand = i === 0
      const isLastCommand = i === commands.length - 1

      // Builtins keep their own quote-aware/array-aware expansion (`expandCommandArgs`) and must
      // not go through `prepareCommand`, which resolves a `$PATH` file that will never exist for
      // them -- there is no `/bin/cd`, deliberately.
      const builtinName = trueBuiltinNameFor(command.words[0])
      let resolved: { finalCommand: string | undefined, args: string[] }
      try {
        resolved = builtinName
          ? { finalCommand: undefined, args: await this.expandCommandArgs(command) }
          : await this.prepareCommand(command)
      } catch (error) {
        // A command that does not exist fails *this command*, exit 127, and the script carries on.
        // It used to throw all the way out of the statement tree, so one typo in a script silently
        // dropped every line after it -- the same unwinding problem readonly and noclobber had, and
        // the reason a typo in a startup file cost you the rest of the file.
        if (!(error instanceof CommandNotFoundError)) throw error
        await this.terminalBuiltinIO().writelnErr(error.message)
        return commands.map(() => 127)
      }
      const args = resolved.args

      let stdin: ReadableStream<Uint8Array> | undefined
      let stdinSource: StdinSource | undefined
      let stdinLeftover: ((bytes: Uint8Array) => void) | undefined
      let stdinIsTTY = false
      // Applies to *any* stage, not only the first -- `a | b < f` redirects b's stdin, discarding
      // whatever a's stdout would have fed it, exactly like a real shell.
      const inputRedirect = command.redirections.find(r => r.fd === 0 && (r.type === '<' || r.type === '<<' || r.type === '<<<'))
      if (inputRedirect) {
        stdin = await this.buildInputStream(inputRedirect)
      } else if (isFirstCommand) {
        // A redirected compound statement's input wins over the keyboard, and is shared rather than
        // reopened, so `while read a; do cat; done < f` hands `cat` what the loop has not read.
        const source = this.currentStdin
        if (source) {
          // Only a builtin gets the shared source, because it reads on demand, one line per call.
          //
          // A real command cannot have it: `Kernel.bridgeStdio` pumps a stage's stdin as fast as the
          // stream yields rather than as the process reads, so handing it over would drain the whole
          // input on the first `echo` in a loop body and starve every later `read`. It gets an
          // immediately-closed stream instead, so it sees EOF rather than the keyboard.
          //
          // Known divergence: `while read a; do cat; done < f` therefore gives `cat` nothing, where
          // bash gives it the rest of `f`. Making that work needs a stdin bridge driven by the
          // process's own reads.
          stdinSource = builtinName ? source : undefined
          stdin = builtinName ? undefined : source.chunks()
          stdinLeftover = builtinName ? undefined : bytes => source.unread(bytes)
        } else {
          stdin = this._terminal.getInputStream()
          stdinIsTTY = true
        }
      } else {
        if (!prevReadable) throw new Error('Pipeline error: missing previous stream')
        stdin = prevReadable
      }

      let pipeWritable: WritableStream<Uint8Array> | undefined
      if (!isLastCommand) {
        const pipe = this._createPipeStream()
        pipeWritable = pipe.writable
        prevReadable = pipe.readable
      }

      // An enclosing aggregate command's redirections come first, so this command's own still win --
      // the same "later wins" rule applied across nesting levels. Resolved once per command, since
      // `inheritedOutputRedirections` also records which fds have already been truncated.
      const redirections = this._statementOutputs.length > 0 || this._execOutputs
        ? [...this.inheritedOutputRedirections(!isLastCommand), ...command.redirections]
        : command.redirections
      const blocked = await this.noclobberTarget(redirections)
      if (blocked) {
        await this.terminalBuiltinIO().writelnErr(`${blocked}: cannot overwrite existing file`)
        return commands.map(() => 1)
      }

      const { stdout, stderr } = await this.buildOutputStreams(redirections, isLastCommand, pipeWritable)
      const stdoutIsTTY = isLastCommand && this._heldStdout.length === 0 && !redirections.some(r => (r.type === '>' || r.type === '>>' || r.type === '>|' || r.type === '>&') && r.fd === 1)
      // Traced as written, not as resolved: bash's xtrace shows `+ echo hi`, not `+ /bin/echo hi`.
      await this.trace([command.words[0] ?? '', ...args])
      const fds = { args, stdin, stdinSource, stdinLeftover, stdinIsTTY, stdout, stdoutIsTTY, drainStdout: isLastCommand, stderr }
      stages.push(builtinName
        ? {
            kind: 'builtin',
            name: builtinName,
            // `eval`/`source` run a statement tree, so their redirections have to reach everything
            // in it rather than only the builtin's own diagnostics.
            aggregate: aggregateBuiltinNames.has(builtinName) ? command.redirections : undefined,
            ...fds
          }
        : { kind: 'command', finalCommand: resolved.finalCommand as string, ...fds })
    }

    const results = await Promise.all(stages.map(async stage => {
      const { args, stdin, stdinSource, stdinLeftover, stdinIsTTY, stdout, stdoutIsTTY, drainStdout, stderr } = stage

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
        if (sharedOut) this._heldStdout.push(view)
        if (source && !stdinSource) this._stdinSources.push(source)
        try {
          return await this.withStatementRedirections(aggregate, () => runTrueBuiltin(this, name, args, io))
        } finally {
          if (source && !stdinSource) this._stdinSources.pop()
          if (sharedOut) this._heldStdout.pop()
          await io.close()
          if (sharedOut) { try { await sharedOut.close() } catch { sharedOut.releaseLock() } }
        }
      }

      return await this._execute({
        command: stage.finalCommand,
        args,
        shell: this,
        terminal: this._terminal,
        stdin,
        stdinLeftover,
        stdinIsTTY,
        stdout,
        stdoutIsTTY,
        drainStdout,
        stderr,
        onProcess: job ? (process => { job.processes.push(process) }) : undefined,
        foreground: job ? !job.background : true
      })
    }))

    return pipeline.negated ? results.map(code => code === 0 ? 1 : 0) : results
  }

  /**
   * bash reports a finished background job only when it next draws PS1, so this is polled at prompt
   * time rather than pushed from `SIGCHLD`. Reporting retires the job from `jobs`.
   */
  takeJobNotifications(): string[] {
    const background = this._jobs.filter(job => job.background || job.status === 'stopped')
    const current = background[background.length - 1]?.id
    const previous = background.length > 1 ? background[background.length - 2]?.id : undefined
    const lines: string[] = []
    for (const job of this._jobs) {
      if (job.status !== 'done' || !job.background || job.notified) continue
      job.notified = true
      const marker = job.id === current ? '+' : job.id === previous ? '-' : ' '
      lines.push(`[${job.id}]${marker}  ${jobStatusLabel(job).padEnd(24)}${job.commandLine} &`)
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

  /**
   * The most recently started job still worth targeting by a bare job spec -- background or
   * stopped, never a plain foreground command that already ran to completion (`jobs`/`fg`/`bg`
   * themselves included, since they always run in the foreground). This is what bash calls the
   * "current job" (`%%`/`%+`), and what bare `fg`/`bg` (no argument) target.
   */
  private get currentJob(): Job | undefined {
    for (let i = this._jobs.length - 1; i >= 0; i--) {
      const job = this._jobs[i]
      if (job && (job.background || job.status === 'stopped')) return job
    }
    return undefined
  }

  /**
   * Resolves a job spec the way bash does: `%N`, `%%`/`%+` (current == most recently started
   * background/stopped job), `%-` (previous such job), a bare pid (matched against any job's
   * process handles), or no argument at all (also the current job, matching bare `fg`/`bg`).
   * Returns `undefined` if nothing matches.
   */
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
      if (!Number.isNaN(id)) return this._jobs.find(job => job.id === id)

      // %name: the most recent job whose command line starts with `name`, e.g. `%sleep`
      return [...this._jobs].reverse().find(job => job.commandLine.startsWith(rest))
    }

    const pid = Number(spec)
    if (!Number.isNaN(pid)) return this._jobs.find(job => job.processes.some(process => process.pid === pid))

    return undefined
  }

  /**
   * Resumes a stopped job's real processes with `SIGCONT`, or promotes an already-running
   * background job to the foreground -- either way, waits for it to finish. A job with no real
   * process handles (a pure-coreutil pipeline) has nothing to send `SIGCONT` to, but is still
   * waited on and reported the same way.
   */
  async fg(spec?: string): Promise<number | undefined> {
    const job = this.getJob(spec)
    if (!job) return undefined

    this._terminal.writeln(job.commandLine)

    if (job.status === 'stopped') {
      for (const process of job.processes) process.kill(Signal.CONT)
      job.status = 'running'
    }

    // Reclaim the controlling terminal for this job's real process(es) -- it gave it up (or never
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

  /**
   * Waits for one job/pid, or (with no argument) every currently-running/stopped background job,
   * to finish. Mirrors bash's `wait`: the single-target form returns that target's exit code; the
   * no-argument form waits for all of them and returns `undefined` (bash's `wait` with no args
   * always exits 0 unless interrupted, which this shell has no equivalent signal for yet).
   */
  async wait(spec?: string): Promise<number | undefined> {
    if (!spec) {
      await Promise.all(this._jobs.filter(job => job.status !== 'done').map(job => job.done))
      return undefined
    }

    const job = this.getJob(spec)
    if (!job) return undefined

    const codes = await job.done
    return codes[codes.length - 1]
  }

  /**
   * A pipeline whose sole command names a registered function is dispatched to `callFunction`
   * instead of `runPipeline`/`_execute` -- functions are shell-local, not real executables, and
   * have no `finalCommand` a binfmt could resolve. Piping into/out of a function, or calling one
   * as a non-final pipeline stage, is out of scope here (real shells restrict this too without a
   * subshell), so only a single-command pipeline qualifies.
   */
  private functionNameFor(pipeline: Pipeline): string | undefined {
    if (pipeline.commands.length !== 1) return undefined
    const name = pipeline.commands[0]?.words[0]
    return name && this._functions.has(name) ? name : undefined
  }

  /**
   * A builtin eligible for the cheap in-place path: the pipeline's sole command names a true shell
   * builtin (`cd`, `export`, ... -- see `lib/shell-builtins.ts`) *and* nothing is redirected, so it
   * can write straight to the terminal without any stream being allocated. `cd` inside a `while`
   * loop takes this path, and it costs what it always did.
   *
   * A builtin that is redirected or piped is not excluded, it just goes the ordinary way, through
   * `runPipeline` as a builtin stage with real fds.
   */
  private fastPathBuiltinFor(pipeline: Pipeline): string | undefined {
    // With `exec > file` installed there is no such thing as "nothing redirected": the shell's own
    // fd 1 is the file, and a builtin writing straight to the terminal would escape it.
    if (this._execOutputs || this._statementOutputs.length > 0) return undefined
    if (pipeline.commands.length !== 1) return undefined
    const command = pipeline.commands[0]
    if (!command || command.redirections.length > 0) return undefined
    return trueBuiltinNameFor(command.words[0])
  }

  /**
   * One word's fields, with brace expansion applied first.
   *
   * Brace expansion is the shell's first expansion and the only one that can turn one word into
   * several *before* anything is looked up: `{a,b}` becomes two words whether or not anything by
   * those names exists. Every path that turns a word into fields goes through here so that
   * `cp a.{txt,bak}`, `mkdir -p src/{lib,bin}` and `for i in {1..5}` all behave the same way.
   */
  private async expandFields(parts: WordPart[], ctx: ExpansionContext): Promise<string[]> {
    return await expandWordFieldsBraced(parts, ctx)
  }

  /** Expands a command's argument words (index 1..) with the quote-aware expander -- true builtins and functions bypass `prepareCommand`, so they need their own array/word-splitting-aware path. */
  private async expandCommandArgs(command: ParsedCommand): Promise<string[]> {
    const ctx = this.expansionContext()
    const fields: string[] = []
    for (let i = 1; i < command.words.length; i++) {
      const parts = command.wordParts[i]
      fields.push(...(parts && parts.length ? await this.expandFields(parts, ctx) : [command.words[i] as string]))
    }
    return fields
  }

  /** Runs a `[[ ... ]]` compound test, returning bash's own 0/1 exit convention. Sets `BASH_REMATCH` on `=~`. */
  private async evaluateConditionalCommand(text: string): Promise<number> {
    const tokens = tokenizeConditional(text)
    const fs: ConditionalFs = {
      exists: (p) => this.context.fs.promises.exists(p),
      isFile: async (p) => { try { return (await this.context.fs.promises.stat(p)).isFile() } catch { return false } },
      isDirectory: async (p) => { try { return (await this.context.fs.promises.stat(p)).isDirectory() } catch { return false } },
      resolve: (p) => path.resolve(this.cwd, p)
    }
    try {
      const result = await evaluateConditional(tokens, this.expansionContext(), fs, (groups) => this.setArray('BASH_REMATCH', groups))
      return result ? 0 : 1
    } catch {
      return 2
    }
  }

  /**
   * Calls a registered function: its own `local` scope, positional parameters set to `argv`.
   *
   * `return` unwinds to here as a `ReturnSignal`, which is the only way it can work -- the function
   * body is an ordinary statement tree, so `return` has to leave it from arbitrary depth.
   *
   * `break`/`continue` deliberately stop here too. In bash a loop is only breakable from within the
   * same function, so a function called from inside a loop cannot break its caller's loop; letting
   * the signal through would make `for f in *; do process "$f"; done` stop the whole loop the first
   * time `process` happened to contain a stray `break`.
   */
  private async callFunction(name: string, argv: string[]): Promise<number> {
    return await this.interpreter.callFunction(name, argv)
  }

  /**
   * Runs `text` in *this* shell, the way `source`/`.` and `eval` do: variables, functions, `cd` and
   * options all persist after it returns, because nothing is forked.
   *
   * Two things separate it from `executeScriptText`:
   *
   * - The `EXIT` trap does not run. A sourced file is not a process exiting, and firing the trap per
   *   `source` would run `~/.ecmashrc`'s cleanup handler the moment the rc file finished loading.
   * - `return` is caught here, since bash lets a sourced script `return` to its caller without
   *   ending the shell; `exit` is deliberately *not* caught, because `exit` in a sourced file exits
   *   the shell that sourced it.
   *
   * `positional` replaces `$1..` for the duration (`source f a b`), restored on the way out.
   */
  async executeSourced(text: string, positional?: string[]): Promise<number> {
    return await this.interpreter.runSourced(text, positional)
  }

  /**
   * Executes a line typed at the prompt (or handed in by any other single-line caller). Most lines
   * are a plain pipeline and go straight to `executeSimple`; a line that itself contains control
   * flow (`if`/`while`/`for`/`case`/a function definition -- whether spread across real `\n`s or
   * typed compact-and-`;`-joined at the prompt) is instead handed to the same
   * `parseStatements`/`executeStatements` machinery `executeScriptText` uses for script files, so
   * `if ...; then ...; fi` typed directly at the terminal behaves identically to running it from a
   * script. `parseStatements` normalizes the compact/`;`-joined form itself
   * (`normalizeInlineControlFlow`); a line that isn't parseable as statements at all (e.g. mismatched
   * quotes) falls back to `executeSimple` so it fails with a normal command error instead of a parser
   * exception.
   */
  async execute(line: string): Promise<number> {
    const trimmed = stripComments(line).trim()
    if (!trimmed) return 0

    // A fresh line is never pre-interrupted: `^C` aborts the line it happened during, not the next.
    // Only at depth 0 -- see `_executeDepth`.
    if (this._executeDepth === 0) this._interrupted = false
    this._executeDepth++
    try {
      return await this.executeParsed(trimmed)
    } catch (signal) {
      // The outermost `execute()` is the last place a control-flow signal can be caught, so this is
      // where `exit 3` typed at the prompt becomes an exit code instead of escaping to `Terminal`'s
      // catch-all and printing an internal error in red. `break`/`continue`/`return` reaching here
      // means there was no enclosing loop or function to act on them, which bash reports and
      // otherwise ignores.
      //
      // `$?` has to be set here too. Every other exit code is recorded by `executeSimple` as it
      // finishes a stage, and a signal unwound straight past that -- so `exit 8` at the prompt
      // returned 8 to the caller while `echo $?` on the next line still printed the code from
      // whatever ran before it. (Found in a browser, not by a unit test: the tests read `execute`'s
      // return value, which was correct all along.)
      if (signal instanceof ExitSignal && this._signalCatchers.exit === 0) return this.reportExit(signal.code)
      if (signal instanceof ReturnSignal && this._signalCatchers.return === 0) {
        await this.terminalBuiltinIO().writelnErr("return: can only `return' from a function or sourced script")
        return this.reportExit(1)
      }
      if ((signal instanceof BreakSignal || signal instanceof ContinueSignal) && this._signalCatchers.loop === 0) {
        await this.terminalBuiltinIO().writelnErr(`${signal.message}: only meaningful in a \`for', \`while', or \`until' loop`)
        return this.reportExit(0)
      }
      throw signal
    } finally {
      this._executeDepth--
    }
  }

  /**
   * Records `code` as `$?` and hands it back, for the paths that bypass `executeSimple`'s own
   * per-stage bookkeeping -- i.e. a control-flow signal unwinding all the way out of `execute`.
   */
  private reportExit(code: number): number {
    this.env.set('?', String(code))
    return code
  }

  /** The body of {@link execute}, minus the interrupt bookkeeping that must not nest. */
  private async executeParsed(trimmed: string): Promise<number> {

    let statements: Statement[]
    try {
      statements = parseStatements(trimmed)
    } catch {
      return this.executeSimple(trimmed)
    }

    if (statements.length !== 1 || statements[0]?.type !== 'simple') {
      return this.executeStatements(statements)
    }

    // Run the *parsed* line, not the raw text. `parseStatements` folds each heredoc body into one
    // self-contained token on its command's own line (`foldHeredocs`), which is the form
    // `executeSimple`/`parseScript` expect. Passing `trimmed` here instead handed `executeSimple`
    // raw text with embedded newlines, so a multi-line heredoc typed at the prompt reached `cat`
    // with an empty body -- while the same text through `executeScriptText` (which goes via
    // `executeStatements`, and so uses `statement.line`) worked correctly.
    await this.traceVerbose(statements[0].line)
    return this.executeSimple(this.expandAliases(statements[0].line))
  }

  /**
   * Executes a single already-simple command line: comment-stripped, parsed into a `Script`, and
   * walked stage by stage honoring `;`, `&&`, `||`, and `&`. A stage whose trailing operator is `&`
   * is registered as a background `Job` (see `@ecmaos/types`' `Job`) and *not* awaited here -- this
   * returns to the caller (the prompt) immediately after printing `[<job-id>] <pid>`, the same way
   * bash reports a backgrounded pipeline. Every other stage runs in the foreground: tracked as
   * `foregroundJob` for the duration (so `^C`/`^Z` in `Terminal.keyHandler` have something to
   * signal) and awaited before the next stage of the line runs. `set -e` aborts the whole line on
   * the first foreground stage that fails without being consumed by `&&`/`||`/negation; `set -o
   * pipefail` changes a pipeline's reported exit code to its last *non-zero* stage rather than
   * strictly its last stage. A backgrounded stage's exit code never affects `$?`/`errexit`/`&&`/`||`
   * on this line -- exactly like bash, which reports it only later via `wait`/the "Done" line in
   * `jobs`.
   */
  private async executeSimple(line: string): Promise<number> {
    return await this.interpreter.runLine(line)
  }

  /**
   * What the shared interpreter needs from this shell: how a pipeline runs, and the pieces of state
   * that live in the kernel's variable map (`$?`, the positional parameters).
   */
  private hostInterface(): InterpreterHost {
    return {
      runPipeline: pipeline => this.runStage(pipeline),
      runBackground: async pipeline => { this.runInBackground(pipeline); return 0 },
      prepareLine: line => stripComments(line).trim(),
      expandStatement: line => this.expandAliases(line),
      onStatement: async statement => { if (statement.type === 'simple') await this.traceVerbose(statement.line) },
      // Array assignments are read from the raw text: the tokenizer splits `a=(x y)` in two.
      runSpecial: line => this.runArrayAssignment(line),
      withRedirect: (statement, run) => this.withStatementRedirection(statement, run),
      expandWords: text => this.expandForWords(text),
      caseSubject: async word => expandWord(word, name => this.lookupVariable(name)),
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
        return () => {
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
      writeErr: message => this.terminalBuiltinIO().writelnErr(message),
    }
  }

  /** `a=(x y)`, `a+=(z)` and `a[i]=v`. `undefined` when the line is not one. */
  private async runArrayAssignment(line: string): Promise<number | undefined> {
    const found = parseArrayAssignment(line)
    if (!found) return undefined
    const ctx = this.expansionContext()
    if (found.local) this.declareLocal(found.name)
    if (found.kind === 'list') {
      const values: string[] = []
      for (const token of found.body.trim() ? tokenize(found.body) : []) {
        if (token.kind === 'word') values.push(...await this.expandFields(token.parts as WordPart[], ctx))
      }
      if (found.append) this.appendArray(found.name, values)
      else this.setArray(found.name, values)
    } else {
      const index = evaluateArithmeticExpression(found.subscript, name => this.lookupVariable(name))
      this.setArrayElement(found.name, index, await expandWordString(tokenizeSingleWord(found.raw || "''"), ctx))
    }
    if (!found.rest || found.operator === '||') return 0
    return await this.interpreter.runLine(found.rest)
  }

  /**
   * `X=1 Y=2` with no command after it: sets the variables in this shell. A readonly name fails the
   * command instead of throwing, because a throw unwinds the whole statement tree and bash carries
   * on. The status is that of the last `$(...)` in the values, as in bash.
   */
  private async runAssignments(assignments: Assignment[]): Promise<number> {
    this._substitutionStatus = undefined
    for (const { name, append, parts } of assignments) {
      const value = await expandWordString(parts, this.expansionContext())
      try {
        this.setVariable(name, value, append)
      } catch (error) {
        await this.terminalBuiltinIO().writelnErr(error instanceof Error ? error.message : String(error))
        return 1
      }
    }
    return this._substitutionStatus ?? 0
  }

  /**
   * Runs one foreground pipeline of a list and reports each stage's status. Which kind of command
   * it is decides how: `exec`, a `[[ ]]`, a true builtin, a function, or a real program.
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
      // True builtins (see `lib/shell-builtins.ts`'s own doc comment) always win over a
      // same-named function or real file, the same way bash's POSIX "special builtins"
      // (cd/export/set/...) can never be shadowed -- checked before `functionNameFor` so a
      // script that happens to define e.g. `function cd { ... }` can't silently break `cd`.
      const command = pipeline.commands[0] as ParsedCommand
      const args = await this.expandCommandArgs(command)
      await this.trace([builtinName, ...args])
      return [negate(await runTrueBuiltin(this, builtinName, args, this.terminalBuiltinIO()))]
    }

    if (fnName) {
      // A function's body is a statement tree, not a command with fds, so `greet > f` has to be
      // held as an aggregate redirection for the whole call. It used to be parsed and dropped.
      const command = pipeline.commands[0] as ParsedCommand
      const args = await this.expandCommandArgs(command)
      await this.trace([fnName, ...args])
      return [negate(await this.withStatementRedirections(command.redirections, () => this.callFunction(fnName, args)))]
    }

    return await this.runForeground(pipeline)
  }

  /**
   * Runs a pipeline in the foreground: registered as `foregroundJob` for the duration so `^C`/`^Z`
   * have a real process to signal, cleared unconditionally once it settles (success, failure, or a
   * thrown error) so a later `^C` at an idle prompt doesn't find a stale foreground job.
   */
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
   * Launches a pipeline in the background (`&`): registers a `Job`, prints bash's `[<id>] <pid>`
   * line, and does *not* await it here -- `job.done` is what `wait`/`jobs` observe later.
   */
  private runInBackground(pipeline: Pipeline): void {
    const job = this.createJob(pipeline, true, /* rethrow */ false)

    // Give the pipeline's first stage a tick to construct its real Process (if it has one) before
    // reporting the job's pid, matching bash's `[1] <pid>` -- falls back to the job id if the stage
    // never produces a real process handle (an all-coreutils pipeline has nothing to report here).
    queueMicrotask(() => {
      const pid = job.processes[0]?.pid
      // `$!` is whatever `[1] <pid>` just reported, including the job-id fallback for an
      // all-coreutils pipeline that never produced a real process.
      this._lastBackgroundPid = pid ?? job.id
      this._terminal.writeln(`[${job.id}] ${pid ?? job.id}`)
    })
  }

  /**
   * Registers a new `Job` for `pipeline` and starts `runPipeline` against it as its `done`
   * executor. `job` is created first (with `processes: []`) specifically so `runPipeline` can push
   * real process handles onto it as they appear while it runs, rather than only after the fact.
   *
   * @param rethrow - Foreground jobs preserve `runPipeline`'s original behavior of propagating a
   * thrown error to `execute()`'s caller (there's still a caller around to see it). A backgrounded
   * job has nobody left to catch it once `execute()` has already returned control to the prompt, so
   * it's reported to the terminal directly and folded into `job.done` as a synthetic failure instead.
   */
  private createJob(pipeline: Pipeline, background: boolean, rethrow: boolean): JobImpl {
    const commandLine = pipeline.commands.map(command => command.words.join(' ')).join(' | ')
    const job = new JobImpl(this._nextJobId++, commandLine, background)
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
   * Runs a statement tree (`control-flow-parser.ts`'s output) top to bottom, dispatching plain
   * lines to `execute()` and interpreting `if`/`while`/`for`/`case`/function-definition nodes
   * itself. This is what `Kernel.executeScript` walks instead of its old flat `line.split('\n')`,
   * and what a function body runs through when called.
   *
   * `break`/`continue`/`return`/`exit` are real builtins that throw (see `@ecmaos/coreutils/lib/shell-core/signals`),
   * caught by the nearest loop here, by `callFunction`, or by `executeScriptText`. They used to be
   * recognized at this level by comparing the statement's whole trimmed text to `'break'` and
   * `'continue'`, which meant `break 2`, `break;` and `test -n x && break` all fell through to a
   * `$PATH` lookup for a `/bin/break` that does not exist.
   */
  async executeStatements(statements: Statement[]): Promise<number> {
    return await this.interpreter.runStatements(statements)
  }

  /**
   * `exec [redirection...]` -- installs redirections on the shell itself.
   *
   * The command form (`exec prog args`) replaces the shell's process image, which ecmaOS has nothing
   * to do yet: the shell is a main-thread object, not a program a worker is running. It is reported
   * rather than approximated, because "run it and carry on" is a different thing with the same
   * spelling. `/bin/ecmash` is where that becomes possible.
   *
   * The redirection-only form is the one scripts actually use -- `exec > run.log 2>&1` at the top of
   * a script sends everything after it to a file -- and that works, because the shell already
   * carries inherited redirections for compound statements.
   */
  private async runExec(command: ParsedCommand): Promise<number> {
    const args = await this.expandCommandArgs(command)
    if (args.length > 0) {
      await this.terminalBuiltinIO().writelnErr('exec: replacing the shell with a command is not supported yet; only redirections are')
      return 1
    }

    const outputs = command.redirections.filter(r => r.fd !== 0 && (r.type === '>' || r.type === '>>' || r.type === '>|' || r.type === '>&'))
    if (outputs.length > 0) this._execOutputs = { redirections: outputs, truncated: new Set() }

    const input = command.redirections.find(r => r.fd === 0 && (r.type === '<' || r.type === '<<' || r.type === '<<<'))
    if (input) {
      // Installed at the bottom of the stack, so a redirected compound statement still wins while it
      // is running and this is what is left underneath when it finishes.
      this._stdinSources.unshift(new StdinSource(await this.buildInputStream(input)))
    }

    return 0
  }

  /**
   * Runs a compound statement with its trailing redirection (`while ...; done < f`, `done > out`) in
   * effect: one open input that every `read` in the body advances through rather than reopening per
   * iteration, and one output that every command in the body writes to rather than the terminal.
   * Statements without a redirection call straight through and allocate nothing.
   */
  private async withStatementRedirection(statement: Redirected, run: () => Promise<number>): Promise<number> {
    if (!statement.redirect) return await run()

    const redirections = parseRedirections(statement.redirect)
    return await this.withStatementRedirections(redirections, run)
  }

  /**
   * The shared implementation behind every aggregate command's redirections: a compound statement's
   * closing keyword, a function call, and `eval`/`source`. All three run a statement tree rather than
   * one command, so all three need the redirection held for the duration instead of attached to a
   * single set of fds.
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
   * A `for` list's values, expanded the way a command's arguments are: quote-aware, with word
   * splitting on `$IFS`, command substitution, arithmetic and globbing.
   *
   * `for f in $x` therefore iterates `$x`'s fields rather than the whole string, `for f in "a b"`
   * stays one value, and `for f in *.txt` matches files.
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
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
    return regex.test(value)
  }

  /**
   * Runs a full script's text (multiple lines, potentially containing control flow and function
   * definitions) to completion. This is `Kernel.executeScript`'s entry point.
   */
  async executeScriptText(script: string): Promise<number> {
    const statements = parseStatements(script)
    this._signalCatchers.exit++
    try {
      return await this.executeStatements(statements)
    } catch (signal) {
      // `exit N` ends the script with code N. The `EXIT` trap still runs, in the `finally` below,
      // because that is precisely when bash runs it.
      if (signal instanceof ExitSignal) { this.reportExit(signal.code); return signal.code }
      throw signal
    } finally {
      this._signalCatchers.exit--
      await this.runTrap('EXIT')
    }
  }

  /**
   * Creates a ReadableStream that reads from a file
   */
  /**
   * A lazy stream over a file or device.
   *
   * Reads one chunk per `pull`, i.e. only as the consumer asks. It used to read the whole input
   * inside `start()` before the stream was usable, which meant an endless character device never
   * returned at all (`head -c 4 < /dev/zero` hung instead of reading four bytes) and a large file was
   * buffered in full.
   */
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
        // A character device that reads as end-of-file has to be recognized here, because no driver
        // can say so: `DeviceFS.read` throws the driver's byte count away, and `@zenfs/core`'s
        // `vfs/file.js` deliberately skips the size clamp for a device and returns the full length
        // requested. So reading `/dev/null` reports a full buffer forever, and `cmd < /dev/null` used
        // to wedge the shell. Devices that really do produce endless data still stream, which is
        // correct now that this is lazy.
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
  private createFileWriteStream(targetPath: string, append: boolean): WritableStream<Uint8Array> {
    const context = this.context

    // The target is rewritten whole from what has been collected, never appended to. `appendFile`
    // on the root filesystem writes each chunk at offset 0 of the file it has just grown, and a
    // handle write at a nonzero offset lands at 0 as well (zenfs 2.7.6, reproduced in the browser
    // and in tests). So `echo a >> f; echo b >> f` left `b` followed by NUL bytes, and a `>` whose
    // output arrived in several chunks did the same. Rewriting is quadratic in the worst case, so it
    // is throttled: at most every 250ms while output flows, and always on close or abort.
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
      await context.fs.promises.writeFile(targetPath, all)
    }

    return new WritableStream({
      // A real shell opens (creating, and for `>` truncating) the target before the command runs,
      // so `cmd > f` leaves `f` empty even if `cmd` never writes a byte.
      start: async () => {
        const existed = append && await context.fs.promises.exists(targetPath)
        if (existed) base = new Uint8Array(await context.fs.promises.readFile(targetPath))
        else await context.fs.promises.writeFile(targetPath, new Uint8Array())
      },
      write: async (chunk) => {
        chunks.push(chunk.slice())
        dirty = true
        if (Date.now() - lastFlush >= 250) await flush()
      },
      close: flush,
      abort: flush
    })
  }

  /**
   * Creates a WritableStream that writes to the terminal
   */
  /**
   * A builtin's fds when it is a lone command with nothing redirected: straight to the terminal,
   * allocating no streams at all. This is the path `cd` in a `while` loop takes, and it costs the
   * same as the old `shell.terminal.writeln` did.
   *
   * `readLine` goes through `terminal.readline()`, which is the editor already used for login and
   * password prompts, so an interactive `read` gets echo and line editing for free.
   */
  /**
   * The input a redirected compound statement opened, if one is active. `read` and a pipeline's
   * first stage prefer it over the terminal when they have no redirection of their own, which is
   * what carries one open file across every iteration of `while ...; done < f`.
   */
  private get currentStdin(): StdinSource | undefined {
    return this._stdinSources[this._stdinSources.length - 1]
  }

  /**
   * `set -C` (noclobber): the first target a `>` would destroy, if any.
   *
   * Only plain `>` is affected. `>>` appends rather than destroying anything, and `>|` is the
   * explicit override, which is why the parser keeps it as a distinct redirection type.
   *
   * Reported rather than thrown: a throw out of the stage builder unwinds the whole statement tree,
   * and a refused redirection is an ordinary command failure that the rest of the script should
   * survive.
   */
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

  /**
   * The stream behind one input redirection: a heredoc body, a here-string, or a real file. Shared by
   * a pipeline stage's `< f` and a compound statement's trailing `done < f`.
   */
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
   * Every enclosing aggregate command's output redirections, outermost first, with a `>` that has
   * already truncated its fd rewritten as `>>`.
   *
   * The rewrite is what makes a body of several commands behave like one redirected stream: without
   * it `for f in a b; do echo $f; done > out` would leave only `b` in `out`, because each `echo`
   * would reopen the file from the top.
   *
   * `notLast` is for a stage that feeds a pipe: fd 1 redirections are left out. Applying them there
   * sent `echo a` in `for ...; do echo a | cat; done > f` to the file instead of the pipe, leaving
   * `cat` waiting on a pipe that never received a byte.
   */
  private inheritedOutputRedirections(notLast = false): Redirection[] {
    const inherited: Redirection[] = []
    const levels = this._execOutputs ? [this._execOutputs, ...this._statementOutputs] : this._statementOutputs
    for (const level of levels) {
      for (const redirection of level.redirections) {
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

  /**
   * Pushes an aggregate command's output redirections for the duration of `run`, so every command in
   * its body inherits them. Allocates nothing when there are none to push.
   */
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
   * Opens a compound statement's trailing redirection (`done < f`) and pushes it, returning a
   * function that pops and closes it. `undefined` when the statement has no redirection, so the
   * common case allocates nothing.
   */
  private async pushStatementStdin(redirections: readonly Redirection[]): Promise<(() => Promise<void>) | undefined> {
    const input = redirections.find(r => r.fd === 0 && (r.type === '<' || r.type === '<<' || r.type === '<<<'))
    if (!input) return undefined

    const source = new StdinSource(await this.buildInputStream(input))
    this._stdinSources.push(source)
    return async () => {
      this._stdinSources.pop()
      await source.close()
    }
  }

  private terminalBuiltinIO(): ShellBuiltinIO {
    const kernelShell = this
    const terminal = this._terminal
    return {
      stdoutIsTTY: true,
      get stdinIsTTY() { return kernelShell.currentStdin === undefined },
      write: async (text: string) => { terminal.write(text) },
      writeln: async (text: string) => { terminal.writeln(text) },
      writeErr: async (text: string) => { terminal.write(`\x1b[31m${text}\x1b[0m`) },
      writelnErr: async (text: string) => { terminal.write(`\x1b[31m${DIAGNOSTIC_PREFIX}${text}\x1b[0m\r\n`) },
      readLine: async (options?: ReadLineOptions) => {
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
   * A builtin's fds when it is redirected or part of a pipeline, over the same streams
   * `buildOutputStreams` hands every `execve`'d command. Writers are acquired lazily so a builtin
   * that never prints anything (the common `cd`/`export` case) doesn't lock a stream it won't use,
   * and `close()` releases whatever was acquired exactly once.
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

    const out = async (text: string) => {
      outWriter ??= stdout.getWriter()
      await outWriter.write(encoder.encode(text))
    }
    const err = async (text: string) => {
      errWriter ??= stderr.getWriter()
      await errWriter.write(encoder.encode(text))
    }

    return {
      stdoutIsTTY,
      stdinIsTTY,
      write: out,
      writeln: async (text: string) => await out(text + '\n'),
      writeErr: err,
      writelnErr: async (text: string) => await err(`${DIAGNOSTIC_PREFIX}${text}\n`),
      readLine: async (options?: ReadLineOptions) => await source?.readLine(options),
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

  /**
   * Creates a pair of WritableStreams that both write to the same file.
   * Used for &> and 2>&1 redirections where stdout and stderr go to the same destination.
   */
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
    
    return {
      stdout: createStream(),
      stderr: createStream()
    }
  }

  /**
   * Substitutes aliases at every command position in `line`.
   *
   * A command position is the start of the line and whatever follows a top-level `;`, `&`, `|`,
   * `&&` or `||` -- the same boundaries `findTopLevelOperatorIndex` already finds, so an alias name
   * appearing as an *argument* (`echo ll`) is never touched.
   *
   * Applied once per *statement*, at the two places a statement reaches `executeSimple`, rather than
   * inside `executeSimple` itself -- which is also reached recursively (by `executeAroundAssignment`)
   * and would expand an already-expanded line a second time, turning `alias echo='echo [x]'` into a
   * doubled prefix.
   *
   * Known limit: because it runs after `parseStatements` rather than before, an alias whose value is
   * control flow (`alias loop='for i in 1 2; do'`) is not recognized as such. Real shells expand
   * before parsing; doing that here would mean expanding the raw line and the parsed statement both.
   *
   * Two rules from real shells that are easy to miss:
   *
   * - Substitution repeats on the result, so one alias can name another. A name already substituted
   *   on this pass is not substituted again, which is what stops `alias ls='ls -la'` looping forever
   *   while still letting it mean "the real `ls`, with flags".
   * - An alias whose value ends in a space makes the *next* word eligible too, which is the entire
   *   reason `alias sudo='sudo '` works in bash.
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
   * How a command name would be resolved, for `type` and `command -v`: the first of alias, keyword,
   * builtin, function or `$PATH` file that claims it, in the order the shell itself checks them.
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

  /**
   * `$1`, `$2`, ... in order, stopping at the first gap. `$0` is excluded: it is the invoked name,
   * not an argument, which is why `shift` never touches it and `$#` never counts it.
   */
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

  /**
   * Loads system-wide configuration from /etc/terminal.toml only
   * Call this before terminal creation foapply system defaults
   */
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
