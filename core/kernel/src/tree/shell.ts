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
  Shell as IShell, ShellBuiltinIO, ShellCreatePipeStream, ShellExecute, ShellOptions, ShellConfig as IShellConfig, Terminal as ITerminal, Users
} from '@ecmaos/types' // TODO: Consistency
import { ThemePresets } from '@ecmaos/types'

import { parseRedirections, parseScript, stripComments, tokenize, tokenizeConditional } from '#lib/shell-parser.ts'
import type { Command as ParsedCommand, Pipeline, Redirection, Script, Token, WordPart } from '#lib/shell-parser.ts'
import { parseStatements } from '#lib/control-flow-parser.ts'
import type { CaseStatement, ForStatement, IfStatement, Redirected, Statement, WhileStatement } from '#lib/control-flow-parser.ts'
import { expandWord, evaluateArithmeticExpression } from '#lib/expand-variables.ts'
import { aggregateBuiltinNames, runTrueBuiltin, trueBuiltinNameFor } from '#lib/shell-builtins.ts'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from '#lib/shell-signals.ts'
import { expandWordFields, expandWordString, expandHeredocBody, type ExpansionContext } from '#lib/word-expansion.ts'
import { evaluateConditional, type ConditionalFs } from '#lib/conditional-eval.ts'

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
const SHELL_ONLY_VARIABLES: ReadonlySet<string> = new Set(['?', '$', '!', '-', '_'])

/** Whether `name` is shell-internal state rather than an environment variable. See {@link SHELL_ONLY_VARIABLES}. */
function isShellOnlyVariable(name: string): boolean {
  return SHELL_ONLY_VARIABLES.has(name) || /^\d+$/.test(name)
}

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
 * Whether word `index` of `words` is a `NAME=VALUE` assignment rather than a command word.
 *
 * POSIX: a leading word is an assignment only while it has the shape `NAME=`, with the `=` itself
 * unquoted -- `"X=1" cmd` runs a command literally named `X=1`, it does not assign anything. The
 * first word that isn't an assignment is the command name, which is why `X=a b` runs `b` rather
 * than assigning the two words `a b`.
 */
function isAssignmentWord(words: string[], wordParts: WordPart[][], index: number): boolean {
  const text = words[index]
  const parts = wordParts[index]
  if (!text || !parts || parts.length === 0) return false
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(text)
  if (!match) return false
  // The name and its `=` have to live entirely inside the word's first part, and that part has to
  // be unquoted, or the `=` came from quoted text and this is an ordinary word.
  const first = parts[0] as WordPart
  return first.quoting === 'unquoted' && first.text.length >= (match[0] as string).length
}

/** How many of `command`'s leading words are `NAME=VALUE` assignment prefixes. */
function assignmentPrefixLength(words: string[], wordParts: WordPart[][]): number {
  let n = 0
  while (n < words.length && isAssignmentWord(words, wordParts, n)) n++
  // A line that is nothing but assignments is a plain assignment, not a prefixed command.
  return n === words.length ? 0 : n
}

/**
 * Lifts every command's leading `NAME=VALUE` words out of a pipeline, returning the commands with
 * those words removed alongside the assignments they stood for.
 *
 * The value keeps its `WordPart[]` rather than being re-parsed from text, so quoting still decides
 * what expands: `X='$HOME' cmd` passes the literal `$HOME` and `X="$HOME" cmd` passes the path.
 */
function stripAssignmentPrefixes(
  commands: readonly ParsedCommand[]
): { commands: readonly ParsedCommand[], prefixes: Array<{ name: string, parts: WordPart[] }> } {
  const prefixes: Array<{ name: string, parts: WordPart[] }> = []
  const stripped = commands.map(command => {
    const n = assignmentPrefixLength(command.words, command.wordParts)
    if (n === 0) return command

    for (let k = 0; k < n; k++) {
      const text = command.words[k] as string
      const parts = command.wordParts[k] as WordPart[]
      const first = parts[0] as WordPart
      const eq = text.indexOf('=')
      prefixes.push({
        name: text.slice(0, eq),
        // `isAssignmentWord` guarantees `NAME=` sits entirely inside part 0, so the value is that
        // part past the `=` plus every later part untouched.
        parts: [{ ...first, text: first.text.slice(eq + 1) }, ...parts.slice(1)]
      })
    }

    return {
      ...command,
      words: command.words.slice(n),
      wordsQuoted: command.wordsQuoted.slice(n),
      wordParts: command.wordParts.slice(n)
    }
  })

  return { commands: stripped, prefixes }
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

  /** The next line without its newline, or `undefined` at EOF. */
  async readLine(): Promise<string | undefined> {
    for (;;) {
      const newline = this.pending.indexOf('\n')
      if (newline !== -1) {
        const line = this.pending.slice(0, newline)
        this.pending = this.pending.slice(newline + 1)
        return line
      }
      if (!await this.fill()) {
        // A final line with no trailing newline is still a line; an empty tail is EOF.
        if (this.pending === '') return undefined
        const line = this.pending
        this.pending = ''
        return line
      }
    }
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
  private _env: Map<string, string>
  private _execute: ShellExecute
  private _filesystem: Filesystem
  private _id: string = crypto.randomUUID()
  private _terminal: ITerminal
  private _terminalWriter?: WritableStreamDefaultWriter<Uint8Array>
  private _tty: number
  private _users: Users

  /** `name() { ... }` / `function name { ... }` bodies registered by `executeStatements`. */
  private _functions = new Map<string, Statement[]>()
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
   * `local` frames, innermost last. A name mapped to `undefined` is a local that `unset` removed:
   * present in the frame, so it still shadows the caller's value, but resolving to nothing -- which is
   * bash's behavior for `local X=1; unset X` (the outer `X` stays hidden until the function returns).
   */
  private _localScopes: Map<string, string | undefined>[] = []
  /** `set -e` / `set -u` / `set -o pipefail`, off by default (matches ecmaOS's prior behavior). */
  private _shellOptions = { errexit: false, nounset: false, pipefail: false }

  /**
   * Indexed arrays (`a=(x y)`, `a[i]=v`, `${a[@]}`). Kept apart from `_env` (which is scalars
   * only) because arrays are never exported to the process environment -- a real shell rejects
   * `export a` for an array too, and this shell simply has no path that would put one in `envObject`.
   * `local` scoping doesn't currently cover arrays; every array is shell/function-global, matching
   * the pre-existing scoping ecmaOS had for everything before `local` was added.
   */
  private _arrays = new Map<string, Map<number, string>>()

  /**
   * `local` frames for the array namespace, pushed and popped alongside `_localScopes`.
   *
   * `local` used to cover scalars only, so every array was shell-global no matter where it was
   * assigned: a function that built up `arr` silently overwrote its caller's `arr`, and a recursive
   * one overwrote its own. `declareLocal` now declares the name in both namespaces, so whichever kind
   * it is later assigned as is local either way. A name mapped to `undefined` is declared local but
   * holds no array yet, which is what hides the caller's while still shadowing the name.
   */
  private _localArrayScopes: Map<string, Map<number, string> | undefined>[] = []

  /**
   * `trap 'cmd' SIG...` handlers, keyed by the signal name they were registered for (`INT`, `TERM`,
   * `EXIT`, ... -- `SIGINT` is normalized to `INT` on registration). A `''` handler means "ignore
   * the signal"; no entry means the default behavior. `runTrap` looks this up and runs the handler
   * as an ordinary shell command line.
   */
  private _traps = new Map<string, string>()

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
   * (see `lib/shell-signals.ts`): a script or sourced file for `exit`, a function call or sourced
   * file for `return`, an enclosing loop for `break`/`continue`.
   *
   * `execute()`'s outermost frame is the last-resort handler for all three, and it needs to know
   * whether some frame *above* it is going to handle the signal instead. Nesting depth alone cannot
   * answer that: a loop condition and the `env` builtin both call `execute()` recursively, so an
   * `exit` inside a script can be one `execute()` frame deep or five, while the script's own
   * handler sits outside `execute()` entirely (`executeScriptText` walks `executeStatements`
   * directly). Counting the real handlers is exact where counting depth is a guess.
   */
  private _signalCatchers = { exit: 0, return: 0, loop: 0 }

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

  /** When this shell started, for `$SECONDS`. Rebased when a script assigns to `SECONDS`. */
  private _secondsOrigin = Date.now()

  /**
   * `$RANDOM`'s generator state. bash seeds its own on assignment (`RANDOM=42`), so this shell does
   * too -- the sequences do not match bash's (nothing portable could), but the contract does: reading
   * gives a fresh value in 0..32767, and assigning makes the sequence that follows reproducible.
   */
  private _randomState = Math.floor(Math.random() * 0x7fffffff) + 1

  /** `$!` -- the pid of the most recently backgrounded pipeline. Unset until one exists, as in bash. */
  private _lastBackgroundPid?: number

  public readonly config: ShellConfig

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
  get env() { return this._env }
  set env(env: Map<string, string>) { this._env = env; this.publishEnv() }
  /**
   * This shell's environment as a plain object: what every child process receives as its `envp`, and
   * what `globalThis.process.env` mirrors.
   *
   * Shell-internal state is filtered out (see {@link SHELL_ONLY_VARIABLES}). It used to be handed
   * over wholesale, so every command started with `?=0` in its environment and a script's positional
   * parameters arrived as `0=/bin/foo`, `1=arg`.
   */
  get envObject() {
    return Object.fromEntries([...this._env].filter(([key]) => !isShellOnlyVariable(key)))
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
  /** Translated strings -- needed by `su`'s error messages, the same way `resolveCommand` uses it. */
  get i18n() { return this._ctx.i18n }

  /**
   * Resolve a variable by name the way `local` scoping requires: the innermost active function
   * frame first, falling through to the shell's real environment. This is what `expandWord`'s
   * `lookup` is bound to everywhere a word is expanded, so `local`-declared variables shadow outer
   * ones exactly where a real shell would.
   */
  lookupVariable(name: string): string | undefined {
    for (let i = this._localScopes.length - 1; i >= 0; i--) {
      const frame = this._localScopes[i] as Map<string, string | undefined>
      if (frame.has(name)) return frame.get(name)
    }
    // Computed parameters sit between the `local` frames and the environment: a `local RANDOM`
    // shadows them the way bash lets you shadow any variable, but a plain `RANDOM=42` does not --
    // that seeds the generator instead of replacing it, which is what `setVariable` does with it.
    const computed = this.computedParameter(name)
    if (computed !== undefined) return computed
    return this._env.get(name)
  }

  /**
   * The special parameters whose value is produced at every read rather than stored.
   *
   * `$?`, `$$`, `$PPID` and `$SHLVL` are deliberately not here: they are ordinary entries in `_env`,
   * written once when they change, so `env` lists them and a child inherits them the way it would in
   * a real shell.
   */
  private computedParameter(name: string): string | undefined {
    switch (name) {
      // bash's range is 0..32767. A 32-bit xorshift keeps the sequence reproducible after a seed.
      case 'RANDOM': {
        let x = this._randomState
        x ^= x << 13
        x ^= x >>> 17
        x ^= x << 5
        this._randomState = x >>> 0 || 1
        return String(this._randomState % 32768)
      }
      case 'SECONDS': return String(Math.floor((Date.now() - this._secondsOrigin) / 1000))
      case '$': return String(this.process.pid)
      case 'PPID': return String(this.process.ppid)
      case '-': return this.optionFlags()
      // Unset until something has been backgrounded, so `${!:-none}` behaves, rather than reading 0.
      case '!': return this._lastBackgroundPid === undefined ? undefined : String(this._lastBackgroundPid)
      default: return undefined
    }
  }

  /**
   * `$-` -- the single-letter flags currently in effect, in the order bash lists them.
   *
   * `h` (hashall) and `B` (brace expansion) are always on and have no `set` switch here, and `i`
   * marks an interactive shell, which every ecmaOS shell is: each one owns a terminal.
   */
  private optionFlags(): string {
    const flags: string[] = []
    if (this._shellOptions.errexit) flags.push('e')
    flags.push('h')
    if (this._shellOptions.nounset) flags.push('u')
    flags.push('B', 'i')
    return flags.join('')
  }

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

  /** `set NAME=VALUE`: writes to the innermost `local` frame if one is active, else the real env. */
  setVariable(name: string, value: string): void {
    const frame = this._localScopes[this._localScopes.length - 1]
    if (frame) { frame.set(name, value); return }

    // Assigning to a computed parameter adjusts what it computes rather than replacing it, which is
    // bash's behavior: `RANDOM=42` seeds the generator and `SECONDS=0` restarts the clock. Storing
    // the value as well would be invisible (the computed read wins) and misleading in `env`.
    if (name === 'RANDOM' && /^\d+$/.test(value)) { this._randomState = Number(value) >>> 0 || 1; return }
    if (name === 'SECONDS' && /^\d+$/.test(value)) { this._secondsOrigin = Date.now() - Number(value) * 1000; return }

    this._env.set(name, value)
    this.publishEnv()
  }

  /**
   * Removes `name`, honoring `local` scoping: the innermost frame that declared it is marked unset,
   * otherwise it goes from the real environment.
   *
   * `unset` used to call `shell.env.delete` directly, which could not remove a local at all -- the
   * frame still shadowed the name, so `$X` kept its local value while the *caller's* `X` was
   * destroyed. Marking the frame instead is what bash does, which is why `$X` reads empty inside the
   * function and the caller's value comes back when it returns.
   */
  unsetVariable(name: string): void {
    for (let i = this._localScopes.length - 1; i >= 0; i--) {
      const frame = this._localScopes[i] as Map<string, string | undefined>
      if (frame.has(name)) { frame.set(name, undefined); return }
    }
    this._env.delete(name)
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
    const visible = new Map<string, string>()
    for (const [key, value] of this._env) if (!isShellOnlyVariable(key)) visible.set(key, value)
    for (const frame of this._localScopes) {
      for (const [key, value] of frame) {
        if (isShellOnlyVariable(key)) continue
        if (value === undefined) visible.delete(key)
        else visible.set(key, value)
      }
    }
    return visible
  }

  /**
   * Indexed arrays -- `arrays` for `word-expansion.ts`'s `lookupArray`, and direct mutators for
   * `=(...)`, `a[i]=`, `unset a[i]`, `a+=(...)`.
   *
   * Every one of these honors `local`: a name declared local in an active frame is read and written
   * there, and the shell-global `_arrays` is only reached when no frame declares it.
   */
  get arrays(): Map<string, Map<number, string>> {
    if (this._localArrayScopes.length === 0) return this._arrays
    const visible = new Map(this._arrays)
    for (const frame of this._localArrayScopes) {
      for (const [key, value] of frame) {
        if (value === undefined) visible.delete(key)
        else visible.set(key, value)
      }
    }
    return visible
  }

  /** The innermost `local` frame declaring `name` in the array namespace, if any. */
  private localArrayFrameFor(name: string): Map<string, Map<number, string> | undefined> | undefined {
    for (let i = this._localArrayScopes.length - 1; i >= 0; i--) {
      const frame = this._localArrayScopes[i] as Map<string, Map<number, string> | undefined>
      if (frame.has(name)) return frame
    }
    return undefined
  }

  /** Reads `name`'s array from the innermost frame that declares it, else from the shell's own. */
  lookupArray(name: string): Map<number, string> | undefined {
    const frame = this.localArrayFrameFor(name)
    return frame ? frame.get(name) : this._arrays.get(name)
  }

  /** Writes `name`'s array to the innermost frame that declares it, else to the shell's own. */
  private storeArray(name: string, array: Map<number, string>): void {
    const frame = this.localArrayFrameFor(name)
    if (frame) frame.set(name, array)
    else this._arrays.set(name, array)
  }

  setArray(name: string, values: string[]): void { this.storeArray(name, new Map(values.map((v, i) => [i, v]))) }
  setArrayElement(name: string, index: number, value: string): void {
    const array = this.lookupArray(name) ?? new Map<number, string>()
    array.set(index, value)
    this.storeArray(name, array)
  }
  appendArray(name: string, values: string[]): void {
    const array = this.lookupArray(name) ?? new Map<number, string>()
    const nextIndex = array.size ? Math.max(...array.keys()) + 1 : 0
    values.forEach((v, i) => array.set(nextIndex + i, v))
    this.storeArray(name, array)
  }
  unsetArrayElement(name: string, index: number): void { this.lookupArray(name)?.delete(index) }
  unsetArray(name: string): void {
    const frame = this.localArrayFrameFor(name)
    if (frame) frame.set(name, undefined)
    else this._arrays.delete(name)
  }

  /**
   * `trap 'cmd' SIG`/`trap - SIG`/`trap '' SIG`/bare `trap`. Signal names are normalized (leading
   * `SIG` stripped, uppercased) so `trap ... SIGINT` and `trap ... INT` register the same handler.
   */
  setTrap(handler: string | undefined, signal: string): void {
    const name = signal.replace(/^SIG/, '').toUpperCase()
    if (handler === undefined) this._traps.delete(name)
    else this._traps.set(name, handler)
  }
  getTrap(signal: string): string | undefined { return this._traps.get(signal.replace(/^SIG/, '').toUpperCase()) }
  listTraps(): Array<[string, string]> { return [...this._traps.entries()] }

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
      glob: (pattern) => this.expandGlob(pattern),
      home: () => this._env.get('HOME'),
      nounset: this._shellOptions.nounset
    }
  }

  /** Declare `name` as local to the current function call, defaulting to '' until assigned. */
  declareLocal(name: string, value?: string): void {
    const frame = this._localScopes[this._localScopes.length - 1]
    const arrayFrame = this._localArrayScopes[this._localArrayScopes.length - 1]
    if (!frame || !arrayFrame) throw new Error('local: can only be used inside a function')
    // `local NAME` with no value declares the name and leaves it *unset*, not set to the empty string,
    // which is what bash does: `${NAME+set}` is empty and `set -u` still objects. Only `local NAME=`
    // sets it to empty. Expansion reads an unset local as empty either way, so the visible difference
    // is exactly the one a script can test for.
    frame.set(name, value)
    // Declared in the array namespace too, holding nothing. Scalars and arrays are separate stores
    // here, so without this a `local arr` followed by `arr=(1 2)` would still write the caller's
    // array -- which is how a recursive function used to overwrite its own.
    if (!arrayFrame.has(name)) arrayFrame.set(name, undefined)
  }

  /** Pushes a fresh `local` frame. Used by `callFunction`, and by nothing else -- `local` needs a call. */
  private pushLocalScope(): void {
    this._localScopes.push(new Map<string, string | undefined>())
    this._localArrayScopes.push(new Map<string, Map<number, string> | undefined>())
  }

  /** Pops the frame `pushLocalScope` pushed, both namespaces together. */
  private popLocalScope(): void {
    this._localScopes.pop()
    this._localArrayScopes.pop()
  }

  /** Apply `set -e` / `-u` / `-o pipefail` style flags. Matches the subset scripts here use. */
  applyShellOption(flag: 'errexit' | 'nounset' | 'pipefail', enabled: boolean): void {
    this._shellOptions[flag] = enabled
  }

  constructor(_options: ShellOptions & { tty?: number }) {
    const options = { ...DefaultShellOptions, ..._options }
    globalThis.shells?.set(this.id, this)

    this._tty = options.tty ?? 0
    this._cwd = options.cwd || localStorage.getItem(`cwd:${this.credentials.uid}`) || DefaultShellOptions.cwd
    this._env = new Map([...Object.entries(DefaultShellOptions.env), ...Object.entries(options.env)])
    this._ctx = options.context
    this._createPipeStream = options.createPipeStream
    this._execute = options.execute
    this._filesystem = options.filesystem
    this._users = options.users
    this._terminal = options.terminal as ITerminal
    this._terminalWriter = this._terminal?.stdout.getWriter() || new WritableStream().getWriter()
    this.config = new ShellConfig(this)

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
   * Loads shell configuration from config files and applies to terminal
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
        if (!key || !value) continue
        let parsedValue = value.trim()

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
   * Parses and executes command substitutions in the format $(command)
   * Supports nested substitutions
   */
  private async parseCommandSubstitution(commandLine: string): Promise<string> {
    let result = commandLine
    let hasSubstitution = true
    
    // Process substitutions iteratively to handle nested cases
    while (hasSubstitution) {
      hasSubstitution = false
      const matches: Array<{ match: string; command: string; start: number; end: number }> = []
      
      // Find all $(...) patterns by tracking parentheses depth
      // Need to track quote state to skip substitutions inside single quotes
      let inSingleQuote = false
      let inDoubleQuote = false
      let escaped = false
      
      for (let i = 0; i < result.length - 1; i++) {
        const char = result[i]
        
        // Track quote state
        if (escaped) {
          escaped = false
          continue
        }
        
        if (char === '\\') {
          escaped = true
          continue
        }
        
        if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote
        } else if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote
        }
        
        // Only process substitutions outside single quotes. `$((` is arithmetic expansion
        // (`expand-variables.ts`'s job, applied later in `prepareCommand`/`tryExecuteAssignment`),
        // not command substitution -- without this guard, `$((I + 1))` gets misread as `$(...)`
        // with body `(I + 1)`, executed as a command, and silently replaced with '' when it fails.
        if (!inSingleQuote && char === '$' && result[i + 1] === '(' && result[i + 2] !== '(') {
          // Found start of substitution, find matching closing paren
          let depth = 1
          let j = i + 2
          let subInString = false
          let subStringChar = ''
          let subEscaped = false
          
          while (j < result.length && depth > 0) {
            const subChar = result[j]
            
            if (subEscaped) {
              subEscaped = false
              j++
              continue
            }
            
            if (subChar === '\\') {
              subEscaped = true
              j++
              continue
            }
            
            if (!subInString && (subChar === '"' || subChar === "'")) {
              subInString = true
              subStringChar = subChar
            } else if (subInString && subChar === subStringChar) {
              subInString = false
              subStringChar = ''
            } else if (!subInString) {
              if (subChar === '(') {
                depth++
              } else if (subChar === ')') {
                depth--
              }
            }
            
            j++
          }
          
          if (depth === 0) {
            // Found complete substitution
            hasSubstitution = true
            const command = result.slice(i + 2, j - 1)
            matches.push({
              match: result.slice(i, j),
              command,
              start: i,
              end: j
            })
            i = j - 1 // Skip past this substitution
          }
        }
      }
      
      // Process matches from right to left to preserve indices
      matches.reverse()
      
      for (const { command, start, end } of matches) {
        // Execute the command substitution
        const output = await this.executeCommandSubstitution(command)
        
        // Replace the substitution with the output
        // Ensure the output is treated as a separate word by checking boundaries
        const beforeChar = start > 0 ? result[start - 1] : ' '
        const afterChar = end < result.length ? result[end] : ' '
        const needsSpaceBefore = beforeChar !== ' ' && beforeChar !== '\t' && beforeChar !== '\n'
        const needsSpaceAfter = afterChar !== ' ' && afterChar !== '\t' && afterChar !== '\n' && afterChar !== ''
        
        const replacement = (needsSpaceBefore ? ' ' : '') + output + (needsSpaceAfter ? ' ' : '')
        result = result.slice(0, start) + replacement + result.slice(end)
      }
    }
    
    return result
  }

  /**
   * Executes a command substitution and returns its output
   */
  private async executeCommandSubstitution(command: string): Promise<string> {
    // Create a temporary stream to capture output
    const chunks: Uint8Array[] = []
    const outputStream = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk)
      }
    })
    
    // Create a dummy error stream (we'll ignore stderr for substitutions)
    const errorStream = new WritableStream<Uint8Array>({
      write() {
        // Ignore stderr in command substitutions
      }
    })
    
    // Execute the command
    try {
      // Parse the command to get command name and args
      const script = parseScript(command)
      const parsedCommand = script.stages[0]?.pipeline.commands[0]
      const [commandName, ...rawWords] = parsedCommand?.words ?? []
      if (!commandName) return ''

      const args = await this.expandGlobWords(rawWords, parsedCommand?.wordsQuoted.slice(1) ?? [])
      const finalCommand = await this.resolveCommand(commandName)
      if (!finalCommand) return ''
      
      // Execute the command
      await this._execute({
        command: finalCommand,
        args,
        shell: this,
        terminal: this._terminal,
        stdin: new ReadableStream<Uint8Array>(),
        stdout: outputStream,
        stderr: errorStream
      })
      
      // Combine all chunks and convert to string
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const combined = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }
      
      // Decode and trim trailing newlines (standard shell behavior)
      const output = new TextDecoder().decode(combined)
      return output.replace(/\n+$/, '')
    } catch {
      return ''
    }
  }

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
   * Expands glob patterns in a command's words, in place of the file(s) they match.
   * A word only globs if it is not fully quoted (`echo *.txt` globs; `echo "*.txt"` does not),
   * matching `parseScript`'s per-word quote tracking.
   * @param words - The command's words, already quote-stripped by the parser
   * @param wordsQuoted - Whether each word (by index) was fully quoted
   * @returns The words with any eligible glob patterns expanded to matching paths
   */
  private async expandGlobWords(words: string[], wordsQuoted: boolean[]): Promise<string[]> {
    const expanded: string[] = []
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string
      const quoted = wordsQuoted[i] ?? false
      if (!quoted && (word.includes('*') || word.includes('?'))) {
        const matches = await this.expandGlob(word)
        expanded.push(...(matches.length > 0 ? matches : [word]))
      } else {
        expanded.push(word)
      }
    }
    return expanded
  }

  /**
   * Expands history bang syntax (e.g., !10) to the corresponding command from history
   * Supports patterns like !N where N is a history line number (1-indexed)
   * Recursively expands history bangs until no more expansions are possible
   */
  private async expandHistoryBang(commandLine: string): Promise<string> {
    const home = this._env.get('HOME') || '/root'
    const historyPath = path.join(home, '.history')

    try {
      if (!await this.context.fs.promises.exists(historyPath)) {
        return commandLine
      }

      const content = await this.context.fs.promises.readFile(historyPath, 'utf-8')
      const historyLines = content.split('\n').filter(line => line.length > 0)

      if (historyLines.length === 0) {
        return commandLine
      }

      let result = commandLine
      let hasExpansion = true
      const maxIterations = 100
      let iterations = 0

      while (hasExpansion && iterations < maxIterations) {
        iterations++
        hasExpansion = false
        let inSingleQuote = false
        let inDoubleQuote = false
        let escaped = false
        let i = 0

        while (i < result.length) {
          const char = result[i]

          if (escaped) {
            escaped = false
            i++
            continue
          }

          if (char === '\\') {
            escaped = true
            i++
            continue
          }

          if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote
            i++
            continue
          }

          if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote
            i++
            continue
          }

          if (!inSingleQuote && char === '!') {
            const nextChar = result[i + 1]
            
            if (nextChar && /[0-9]/.test(nextChar)) {
              let numStr = ''
              let j = i + 1
              
              while (j < result.length) {
                const char = result[j]
                if (char && /[0-9]/.test(char)) {
                  numStr += char
                  j++
                } else {
                  break
                }
              }

              const historyNum = parseInt(numStr, 10)
              
              if (historyNum >= 1 && historyNum <= historyLines.length) {
                const historyCommand = historyLines[historyNum - 1]
                if (historyCommand) {
                  result = result.slice(0, i) + historyCommand + result.slice(j)
                  hasExpansion = true
                  break
                }
              }
              
              throw new Error(`!${historyNum}: event not found`)
            }
          }

          i++
        }
      }

      if (iterations >= maxIterations) {
        throw new Error('History expansion exceeded maximum iterations (possible circular reference)')
      }

      return result
    } catch (error) {
      if (error instanceof Error && (error.message.includes('event not found') || error.message.includes('maximum iterations'))) {
        throw error
      }
      return commandLine
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
      const created = fd === 1
        ? (isLastCommand ? this.createTerminalOutputStream() : (pipeWritable as WritableStream<Uint8Array>))
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

      if (redirection.type === '>' || redirection.type === '>>') {
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
      // `wordParts` (quote-aware) is what the parser actually produced; falling back to the old
      // string-based path only covers a caller that hand-builds a `Command` without it (none do
      // today, but this keeps `prepareCommand` total rather than throwing on an empty array).
      if (parts && parts.length) {
        fields.push(...await expandWordFields(parts, ctx))
      } else {
        let expanded = await this.parseCommandSubstitution(word)
        expanded = await this.expandHistoryBang(expanded)
        expanded = this.expandTilde(expanded)
        if (!command.wordsQuoted[index]) expanded = expandWord(expanded, (name) => this.lookupVariable(name))
        fields.push(expanded)
      }
    }

    const [commandName, ...args] = fields
    if (!commandName) {
      throw new Error(this._ctx.i18n.t('commandNotFound', { ns: 'kernel', command: command.words.join(' ') }))
    }

    const finalCommand = await this.resolveCommand(commandName)
    if (!finalCommand) {
      throw new Error(this._ctx.i18n.t('commandNotFound', { ns: 'kernel', command: commandName }))
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
    const { commands, prefixes } = stripAssignmentPrefixes(pipeline.commands)
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
  private async applyAssignmentPrefixes(entries: Array<{ name: string, parts: WordPart[] }>): Promise<() => void> {
    const saved = entries.map(({ name }) => ({ name, had: this.env.has(name), previous: this.env.get(name) }))
    for (const { name, parts } of entries) {
      this.env.set(name, await expandWordString(parts, this.expansionContext()))
    }
    return () => {
      for (const { name, had, previous } of saved) {
        if (had) this.env.set(name, previous as string)
        else this.env.delete(name)
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
      const resolved = builtinName
        ? { finalCommand: undefined, args: await this.expandCommandArgs(command) }
        : await this.prepareCommand(command)
      const args = resolved.args

      let stdin: ReadableStream<Uint8Array> | undefined
      let stdinSource: StdinSource | undefined
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
          stdin = builtinName ? undefined : new ReadableStream({ start: controller => controller.close() })
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
      const redirections = this._statementOutputs.length > 0
        ? [...this.inheritedOutputRedirections(), ...command.redirections]
        : command.redirections
      const { stdout, stderr } = await this.buildOutputStreams(redirections, isLastCommand, pipeWritable)
      const stdoutIsTTY = isLastCommand && !redirections.some(r => (r.type === '>' || r.type === '>>' || r.type === '>&') && r.fd === 1)
      const fds = { args, stdin, stdinSource, stdinIsTTY, stdout, stdoutIsTTY, drainStdout: isLastCommand, stderr }
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
      const { args, stdin, stdinSource, stdinIsTTY, stdout, stdoutIsTTY, drainStdout, stderr } = stage

      if (stage.kind === 'builtin') {
        const io = this.streamBuiltinIO(stdinSource ?? stdin, stdinIsTTY, stdout, stdoutIsTTY, stderr)
        const name = stage.name
        const aggregate = stage.aggregate
        try {
          return aggregate
            ? await this.withStatementRedirections(aggregate, () => runTrueBuiltin(this, name, args, io))
            : await runTrueBuiltin(this, name, args, io)
        } finally {
          await io.close()
        }
      }

      return await this._execute({
        command: stage.finalCommand,
        args,
        shell: this,
        terminal: this._terminal,
        stdin,
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
    if (pipeline.commands.length !== 1) return undefined
    const command = pipeline.commands[0]
    if (!command || command.redirections.length > 0) return undefined
    return trueBuiltinNameFor(command.words[0])
  }

  /** Expands a command's argument words (index 1..) with the quote-aware expander -- true builtins and functions bypass `prepareCommand`, so they need their own array/word-splitting-aware path. */
  private async expandCommandArgs(command: ParsedCommand): Promise<string[]> {
    const ctx = this.expansionContext()
    const fields: string[] = []
    for (let i = 1; i < command.words.length; i++) {
      const parts = command.wordParts[i]
      fields.push(...(parts && parts.length ? await expandWordFields(parts, ctx) : [command.words[i] as string]))
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
    const body = this._functions.get(name)
    if (!body) throw new Error(`${name}: function not found`)

    const savedPositional = new Map<string, string>()
    for (const key of this.env.keys()) if (!isNaN(parseInt(key))) savedPositional.set(key, this.env.get(key) as string)

    this.pushLocalScope()
    // `setPositionalParameters` sets $0 to its first element (matching the device-CLI convention
    // for a device command line, where $0 is the invoked name and $1.. are the real arguments) -- so
    // the function's own name goes first, keeping $1 as the caller's first argument like bash.
    this.setPositionalParameters([name, ...argv])
    this._signalCatchers.return++
    // A function body is a loop boundary as far as `break` is concerned, so its own last-resort
    // handler must not defer to a loop in the *caller* that it will never reach.
    const enclosingLoops = this._signalCatchers.loop
    this._signalCatchers.loop = 0
    try {
      return await this.executeStatements(body)
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.code
      if (signal instanceof BreakSignal || signal instanceof ContinueSignal) {
        await this.terminalBuiltinIO().writelnErr(`${signal.message}: only meaningful in a \`for', \`while', or \`until' loop`)
        return 0
      }
      throw signal
    } finally {
      this._signalCatchers.return--
      this._signalCatchers.loop = enclosingLoops
      this.popLocalScope()
      this.clearPositionalParameters()
      for (const [key, value] of savedPositional) this.env.set(key, value)
    }
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
    const statements = parseStatements(text)

    const savedPositional = positional
      ? new Map([...this.env.entries()].filter(([key]) => !isNaN(parseInt(key))))
      : undefined
    if (positional) this.setPositionalParameters([this.env.get('0') ?? 'ecmaos', ...positional])

    this._signalCatchers.return++
    try {
      return await this.executeStatements(statements)
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.code
      throw signal
    } finally {
      this._signalCatchers.return--
      if (savedPositional) {
        this.clearPositionalParameters()
        for (const [key, value] of savedPositional) this.env.set(key, value)
      }
    }
  }

  /**
   * `VAR=value` (and `VAR=` for an empty assignment) as a bare statement -- not `env VAR=value cmd`,
   * which already works today by other means, but a line that *starts* with an assignment. A real
   * shell recognizes this at the parser level (it's not a command at all, and `=` is not an
   * operator); recognizing it here, at the same point `execute` decides what kind of line this is,
   * avoids teaching `shell-parser.ts` a whole new statement kind for something that never pipes or
   * redirects. Returns the exit code if `line` started with an assignment, else `undefined` so
   * `execute` falls through to normal pipeline parsing.
   *
   * The value only extends up to the first top-level (unquoted, not inside `$(...)`/`$((...))`)
   * `;`/`&&`/`||`/`&`/`|` -- `x=5; echo $x` must run `echo $x` as its own statement, not swallow it
   * into `x`'s value. Whatever follows that boundary is hand back to `execute` recursively; an
   * assignment always "succeeds" (exit 0) unless expansion itself throws, so `;`/`&&` both continue
   * into the remainder and `||` skips it, matching how a real shell treats a successful command.
   */
  /**
   * Whether `line` is `NAME=VALUE... command args` rather than a plain assignment: after its run of
   * leading assignment words, a command word remains.
   *
   * Only the words before the first operator or redirection are considered, so `X=1; cmd` stays a
   * plain assignment while `X=1 cmd` does not.
   */
  private hasAssignmentPrefix(line: string): boolean {
    let tokens: Token[]
    try {
      tokens = tokenize(line)
    } catch {
      // Unparseable here is not this method's problem to report; let the normal path raise it.
      return false
    }

    const words: string[] = []
    const parts: WordPart[][] = []
    for (const token of tokens) {
      if (token.kind !== 'word') break
      words.push(token.value)
      parts.push(token.parts ?? [])
    }

    return assignmentPrefixLength(words, parts) > 0
  }

  /**
   * Whether `text` *starts* with a bare assignment -- `x=1`, `a=(x y)`, `a[i]=v` -- rather than a
   * command. In other words, whether {@link tryExecuteAssignment} would claim it.
   *
   * `X=1 cmd` is deliberately not one: that is a command carrying prefix assignments, which belongs
   * to `runPipeline` so the values are scoped to that command alone.
   */
  private beginsBareAssignment(text: string): boolean {
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=\(/.test(text)) return true
    if (/^[A-Za-z_][A-Za-z0-9_]*\[[^\]]+\]=/.test(text)) return true
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return false
    return !this.hasAssignmentPrefix(text)
  }

  /**
   * Finds the first top-level operator that an assignment follows, so `echo hi; x=1` can be run as
   * "the command, then the assignment".
   *
   * Only `;`, `&&` and `||` qualify. A `|` cannot be followed by an assignment in any meaningful
   * sense, and a `&` backgrounds what came before it -- both keep their existing handling in
   * `parseScript`, which is also why the common case (no assignment anywhere but the head) returns
   * `undefined` here and nothing about it changes.
   *
   * An array literal's own parentheses are why this works on the raw text rather than on the parsed
   * pipeline: `arr=(a b)` tokenizes into the two words `arr=(a` and `b)`, so by the time there are
   * words to inspect the assignment is no longer recognizable as one.
   */
  private splitBeforeAssignment(line: string): { head: string, operator: string, rest: string } | undefined {
    let offset = 0
    while (offset < line.length) {
      const relative = findTopLevelOperatorIndex(line.slice(offset))
      if (relative === -1) return undefined

      const index = offset + relative
      const pair = line.slice(index, index + 2)
      const operator = pair === '&&' || pair === '||' ? pair : (line[index] as string)
      const rest = line.slice(index + operator.length).trim()

      if (operator !== '|' && operator !== '&' && this.beginsBareAssignment(rest)) {
        return { head: line.slice(0, index).trim(), operator, rest }
      }

      offset = index + operator.length
    }

    return undefined
  }

  /**
   * Runs the command before a mid-line assignment, then the assignment and whatever follows it,
   * honoring the operator between them exactly as the ordinary stage loop would: `&&` only continues
   * on success, `||` only on failure, and `set -e` stops after a failing `;`.
   */
  private async executeAroundAssignment({ head, operator, rest }: { head: string, operator: string, rest: string }): Promise<number> {
    const headExit = head ? await this.executeSimple(head) : 0
    if (this._interrupted) return headExit
    if (operator === '&&' && headExit !== 0) return headExit
    if (operator === '||' && headExit === 0) return headExit
    if (operator === ';' && this._shellOptions.errexit && headExit !== 0) return headExit
    return await this.execute(rest)
  }

  private async tryExecuteAssignment(line: string): Promise<number | undefined> {
    // Array forms: `a=(x y)`, `a+=(z)`, `a[i]=v`. Checked before the plain scalar match below,
    // since `a[i]=v` would otherwise fail the scalar regex and fall through unhandled, and
    // `a=(...)`/`a+=(...)` would otherwise be treated as a scalar assigned the literal text `(x y)`.
    const arrayLiteral = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=\(([\s\S]*?)\)(?:\s*(?:;|&&|\|\||&|\|)\s*([\s\S]*))?$/.exec(line)
    if (arrayLiteral) {
      const [, name, append, body, remainder] = arrayLiteral as unknown as [string, string, string, string, string | undefined]
      const words = body.trim().length ? tokenize(body).filter(t => t.kind === 'word') : []
      const values = await Promise.all(words.map(t => expandWordFields((t.parts as WordPart[]), this.expansionContext())))
      const flat = values.flat()
      if (append) this.appendArray(name, flat)
      else this.setArray(name, flat)
      return remainder ? await this.execute(remainder.trim()) : 0
    }

    const elementAssignment = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]=/.exec(line)
    if (elementAssignment) {
      const [full, name, subscript] = elementAssignment as unknown as [string, string, string]
      const rest = line.slice(full.length)
      const boundary = findTopLevelOperatorIndex(rest)
      const rawValue = boundary === -1 ? rest : rest.slice(0, boundary)
      const index = evaluateArithmeticExpression(subscript, (n) => this.lookupVariable(n))
      const value = await expandWordString(tokenizeSingleWord(rawValue), this.expansionContext())
      this.setArrayElement(name, index, value)
      if (boundary === -1) return 0
      const opLen = (rest[boundary] === '&' && rest[boundary + 1] === '&') || (rest[boundary] === '|' && rest[boundary + 1] === '|') ? 2 : 1
      const operator = rest.slice(boundary, boundary + opLen)
      if (operator === '||') return 0
      const remainder = rest.slice(boundary + opLen).trim()
      return remainder ? await this.execute(remainder) : 0
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
    if (!match) return undefined

    // `NAME=VALUE... command args` is a command carrying prefix assignments, not an assignment, so
    // it belongs to `parseScript`/`runPipeline` (which scopes those assignments to that pipeline and
    // gets `;`/`&&`/`||` semantics for free). Without this, `findTopLevelOperatorIndex` finds no
    // operator in `IFS= read -r line` and stores the whole `read -r line` as IFS's value.
    if (this.hasAssignmentPrefix(line)) return undefined

    const name = match[0].slice(0, -1)
    const rest = line.slice(match[0].length)
    const boundary = findTopLevelOperatorIndex(rest)
    const rawValue = boundary === -1 ? rest : rest.slice(0, boundary)

    let value = await this.parseCommandSubstitution(rawValue)
    value = this.expandTilde(value)
    value = expandWord(value, (varName) => this.lookupVariable(varName))
    // Strip one layer of surrounding quotes the way word-splitting elsewhere in this file does --
    // `X="a b"` should store `a b`, not `"a b"`.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    this.setVariable(name, value)
    if (boundary === -1) return 0

    const opLen = (rest[boundary] === '&' && rest[boundary + 1] === '&') || (rest[boundary] === '|' && rest[boundary + 1] === '|') ? 2 : 1
    const operator = rest.slice(boundary, boundary + opLen)
    if (operator === '||') return 0

    const remainder = rest.slice(boundary + opLen).trim()
    return remainder ? await this.execute(remainder) : 0
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
    return this.executeSimple(statements[0].line)
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
    const lineWithoutComments = stripComments(line).trim()
    if (!lineWithoutComments) return 0

    const assignmentExitCode = await this.tryExecuteAssignment(lineWithoutComments)
    if (assignmentExitCode !== undefined) return assignmentExitCode

    // An assignment that isn't the *first* thing on the line (`echo hi; x=1`). `tryExecuteAssignment`
    // above only ever looked at the head, and handled a trailing one by recursing into the remainder
    // -- which never happened when the head was an ordinary command, so `x=1` reached `parseScript`
    // and failed as a command not found. Splitting the line here hands the tail back through
    // `execute`, where the assignment is once again at the head.
    const split = this.splitBeforeAssignment(lineWithoutComments)
    if (split) return await this.executeAroundAssignment(split)

    const script: Script = parseScript(lineWithoutComments)
    let lastPipelineExit = 0
    let skipNext = false

    for (const stage of script.stages) {
      if (skipNext) {
        skipNext = false
      } else if (stage.operator === '&') {
        this.runInBackground(stage.pipeline)
      } else {
        const conditionalCommand = stage.pipeline.commands.length === 1 ? stage.pipeline.commands[0] : undefined
        const builtinName = conditionalCommand?.conditional !== undefined ? undefined : this.fastPathBuiltinFor(stage.pipeline)
        const fnName = builtinName ? undefined : this.functionNameFor(stage.pipeline)
        let pipeStatus: number[]

        if (conditionalCommand?.conditional !== undefined) {
          const code = await this.evaluateConditionalCommand(conditionalCommand.conditional)
          pipeStatus = [stage.pipeline.negated ? (code === 0 ? 1 : 0) : code]
        } else if (builtinName) {
          // True builtins (see `lib/shell-builtins.ts`'s own doc comment) always win over a
          // same-named function or real file, the same way bash's POSIX "special builtins"
          // (cd/export/set/...) can never be shadowed -- checked before `functionNameFor` so a
          // script that happens to define e.g. `function cd { ... }` can't silently break `cd`.
          const command = stage.pipeline.commands[0] as ParsedCommand
          const args = await this.expandCommandArgs(command)
          const code = await runTrueBuiltin(this, builtinName, args, this.terminalBuiltinIO())
          pipeStatus = [stage.pipeline.negated ? (code === 0 ? 1 : 0) : code]
        } else if (fnName) {
          // A function's body is a statement tree, not a command with fds, so `greet > f` has to be
          // held as an aggregate redirection for the whole call. It used to be parsed and dropped.
          const command = stage.pipeline.commands[0] as ParsedCommand
          const args = await this.expandCommandArgs(command)
          const code = await this.withStatementRedirections(command.redirections, () => this.callFunction(fnName, args))
          pipeStatus = [stage.pipeline.negated ? (code === 0 ? 1 : 0) : code]
        } else {
          pipeStatus = await this.runForeground(stage.pipeline)
        }

        lastPipelineExit = this._shellOptions.pipefail
          ? ([...pipeStatus].reverse().find(code => code !== 0) ?? 0)
          : pipeStatus[pipeStatus.length - 1] ?? 0

        this.setArray('PIPESTATUS', pipeStatus.map(String))
        this.env.set('?', String(lastPipelineExit))

        if (this._shellOptions.errexit && lastPipelineExit !== 0 && stage.operator !== '&&' && stage.operator !== '||') {
          return lastPipelineExit
        }

        // `^C` aborts the whole list, as in bash -- `sleep 25; echo done` must not print `done`.
        if (this._interrupted) return lastPipelineExit
      }

      // && only runs its next stage on success; || only on failure. A skipped stage's own trailing
      // operator still governs what comes after it, so `a && b || c` runs c when a fails too.
      if (stage.operator === '&&' && lastPipelineExit !== 0) skipNext = true
      else if (stage.operator === '||' && lastPipelineExit === 0) skipNext = true
    }

    return lastPipelineExit
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
   * `break`/`continue`/`return`/`exit` are real builtins that throw (see `lib/shell-signals.ts`),
   * caught by the nearest loop here, by `callFunction`, or by `executeScriptText`. They used to be
   * recognized at this level by comparing the statement's whole trimmed text to `'break'` and
   * `'continue'`, which meant `break 2`, `break;` and `test -n x && break` all fell through to a
   * `$PATH` lookup for a `/bin/break` that does not exist.
   */
  async executeStatements(statements: Statement[]): Promise<number> {
    let lastExit = 0

    for (const statement of statements) {
      // `^C` unwinds the whole statement tree, not just the pipeline it landed on -- a `for` loop
      // whose body was interrupted stops, rather than starting its next iteration. Checked here (at
      // every nesting level) as well as in `executeSimple`'s stage loop, since a loop body is its
      // own `executeStatements` call and would otherwise continue on its own.
      if (this._interrupted) return lastExit

      switch (statement.type) {
        case 'simple': {
          lastExit = await this.executeSimple(statement.line)
          break
        }

        case 'function': {
          this._functions.set(statement.name, statement.body)
          lastExit = 0
          break
        }

        // The four compound statements can carry a redirection on their closing keyword
        // (`done < f`), which opens one input for the whole statement -- see `withStatementStdin`.
        case 'if': {
          lastExit = await this.withStatementRedirection(statement, () => this.executeIf(statement))
          break
        }

        case 'while': {
          lastExit = await this.withStatementRedirection(statement, () => this.executeWhile(statement))
          break
        }

        case 'for': {
          lastExit = await this.withStatementRedirection(statement, () => this.executeFor(statement))
          break
        }

        case 'case': {
          lastExit = await this.withStatementRedirection(statement, () => this.executeCase(statement))
          break
        }
      }

      if (this._shellOptions.errexit && lastExit !== 0 && statement.type === 'simple') return lastExit
    }

    return lastExit
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
    return await this.withStatementOutputs(redirections, async () => {
      const pop = await this.pushStatementStdin(redirections)
      if (!pop) return await run()
      try {
        return await run()
      } finally {
        await pop()
      }
    })
  }

  private async executeIf(statement: IfStatement): Promise<number> {
    for (const branch of statement.branches) {
      if (await this.execute(branch.condition) === 0) return this.executeStatements(branch.body)
    }
    if (statement.elseBody) return this.executeStatements(statement.elseBody)
    return 0
  }

  private async executeWhile(statement: WhileStatement): Promise<number> {
    let lastExit = 0
    while (await this.execute(statement.condition) === 0) {
      this._signalCatchers.loop++
      try {
        lastExit = await this.executeStatements(statement.body)
      } catch (signal) {
        const unwind = this.unwindLoop(signal)
        if (unwind === 'break') break
        if (unwind === 'continue') continue
        throw signal
      } finally {
        this._signalCatchers.loop--
      }
    }
    return lastExit
  }

  /**
   * How an enclosing loop should react to a thrown signal: `break`/`continue` this loop, or
   * `undefined` for "not mine, rethrow".
   *
   * `break N`/`continue N` target the Nth enclosing loop, so a signal with `level` still above 1 is
   * counted down one and rethrown for the loop outside this one to act on. That is why the count
   * lives on the signal rather than on the shell: it unwinds with the exception, so it cannot be
   * left behind by a loop that exits some other way.
   */
  private unwindLoop(signal: unknown): 'break' | 'continue' | undefined {
    if (!(signal instanceof BreakSignal) && !(signal instanceof ContinueSignal)) return undefined
    if (signal.level > 1) {
      signal.level--
      throw signal
    }
    return signal instanceof BreakSignal ? 'break' : 'continue'
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
      values.push(...await expandWordFields(token.parts ?? [], ctx))
    }
    return values
  }

  private async executeFor(statement: ForStatement): Promise<number> {
    let lastExit = 0
    for (const word of await this.expandForWords(statement.wordsText)) {
      this.setVariable(statement.variable, word)
      this._signalCatchers.loop++
      try {
        lastExit = await this.executeStatements(statement.body)
      } catch (signal) {
        const unwind = this.unwindLoop(signal)
        if (unwind === 'break') break
        if (unwind === 'continue') continue
        throw signal
      } finally {
        this._signalCatchers.loop--
      }
    }
    return lastExit
  }

  /** `*` matches anything; other patterns are matched as shell globs (`?` any char, literal else). */
  private matchesCasePattern(value: string, pattern: string): boolean {
    if (pattern === '*') return true
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
    return regex.test(value)
  }

  private async executeCase(statement: CaseStatement): Promise<number> {
    const value = expandWord(statement.word, (name) => this.lookupVariable(name))
    for (const clause of statement.clauses) {
      if (clause.patterns.some(pattern => this.matchesCasePattern(value, pattern))) {
        return this.executeStatements(clause.body)
      }
    }
    return 0
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
      if (signal instanceof ExitSignal) return signal.code
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

    return new WritableStream({
      // A real shell opens (creating, and for `>` truncating) the target before the command runs,
      // so `cmd > f` leaves `f` empty even if `cmd` never writes a byte.
      start: async () => {
        if (append && await context.fs.promises.exists(targetPath)) return
        await context.fs.promises.writeFile(targetPath, new Uint8Array())
      },
      write: async (chunk) => {
        await context.fs.promises.appendFile(targetPath, chunk)
      }
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
   */
  private inheritedOutputRedirections(): Redirection[] {
    const inherited: Redirection[] = []
    for (const level of this._statementOutputs) {
      for (const redirection of level.redirections) {
        if (redirection.type !== '>') { inherited.push(redirection); continue }
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
      writelnErr: async (text: string) => { terminal.write(`\x1b[31m${text}\x1b[0m\r\n`) },
      readLine: async (options?: { prompt?: string, silent?: boolean }) => {
        const source = this.currentStdin
        if (source) return await source.readLine()
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
      writelnErr: async (text: string) => await err(text + '\n'),
      readLine: async () => await source?.readLine(),
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

  /**
   * `shift [N]`: drops the first N positional parameters and renumbers the rest, leaving `$0` alone.
   *
   * Returns false without changing anything when N exceeds `$#`, which is how bash's `shift` reports
   * failure -- and what makes `while [ $# -gt 0 ]; do ...; shift; done` terminate rather than spin.
   */
  shiftPositionalParameters(count: number): boolean {
    const positional = this.positionalParameters
    if (count < 0 || count > positional.length) return false
    const zero = this.env.get('0')
    this.setPositionalParameters([zero ?? '', ...positional.slice(count)])
    if (zero === undefined) this.env.delete('0')
    return true
  }
}



/**
 * Default configuration values
 */
export const DefaultConfig: IShellConfig = {
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

export class ShellConfig implements IShellConfig {
  private _noBell: boolean = DefaultConfig.noBell! // Bang because we know default exists
  private _fontFamily: string = DefaultConfig.fontFamily!
  private _fontSize: number = DefaultConfig.fontSize!
  private _cursorBlink: boolean = DefaultConfig.cursorBlink!
  private _cursorStyle: 'block' | 'underline' | 'bar' = DefaultConfig.cursorStyle!
  private _theme: IShellConfig['theme'] = { ...DefaultConfig.theme }
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
  private applyConfig(config: Partial<IShellConfig>) {
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
   * Loads system-wide configuration from /etc/shell.toml only
   * Call this before terminal creation foapply system defaults
   */
  async loadSystemConfig() {
    try {
      if (await this._shell.context.fs.promises.exists('/etc/shell.toml')) {
        const content = await this._shell.context.fs.promises.readFile('/etc/shell.toml', 'utf-8')
        const config = parse(content) as Partial<IShellConfig>
        this.applyConfig(config)
      }
    } catch (error) {
      console.warn('Failed to load system shell config:', error)
    }
  }

  /**
   * Loads configuration from /etc/shell.toml and ~/.config/shell.toml
   */
  async load() {
    // Load system default config first
    await this.loadSystemConfig()

    // Load user config second (overwrites system defaults)
    try {
      const home = this._shell.env.get('HOME')
      if (home) {
        const configPath = `${home}/.config/shell.toml`
        if (await this._shell.context.fs.promises.exists(configPath)) {
          const content = await this._shell.context.fs.promises.readFile(configPath, 'utf-8')
          const config = parse(content) as Partial<IShellConfig>
          this.applyConfig(config)
        }
      }
    } catch (error) {
      console.warn('Failed to load user shell config:', error)
    }
  }

  setTheme(theme: string | IShellConfig['theme']) {
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
