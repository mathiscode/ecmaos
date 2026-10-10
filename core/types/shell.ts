/**
 * Shell types and interfaces
 */

import type { BoundContext, Credentials } from '@zenfs/core'
import type { Filesystem } from './filesystem.ts'
import type { JobProcessHandle, KernelContext, KernelExecuteOptions } from './kernel.ts'
import type { Terminal, TerminalConfigManager } from './terminal.ts'
import type { Users } from './users.ts'

/**
 * A background/foreground job's lifecycle state, mirroring bash's `Running`/`Stopped`/`Done`:
 * - `running`: actively executing (foreground or background)
 * - `stopped`: suspended by `^Z`/`SIGTSTP`, resumable with `fg`/`bg` (`SIGCONT`)
 * - `done`: finished; kept around only long enough for `jobs`/`wait` to observe its exit code
 */
export type JobStatus = 'running' | 'stopped' | 'done'

/**
 * One pipeline the shell is tracking for job control: `a | b | c &` is a single job with one entry
 * in `processes` per stage that went through a real `@zenfs/linux` Process (`executeViaExecve`'s
 * `js`/`node` binfmt path) -- a pipeline of ordinary coreutils has no process handle at all, since
 * those run synchronously in the shell's own tick and can't be signaled independently. This is a
 * deliberately simplified single-foreground-job model, not POSIX process groups: `@zenfs/linux`
 * exposes one thread per `Process` and no pgid concept, so "the foreground job" is tracked as a
 * single `Job` reference on `Shell` rather than real pgid-based terminal control.
 */
export interface Job {
  /** 1-indexed job number, as shown by `jobs`/`fg`/`bg` (`[1]`, `[2]`, ...) */
  id: number
  /** The command line as typed, for `jobs`' display */
  commandLine: string
  status: JobStatus
  /** Exit code(s) of the pipeline's stage(s), set once `status` becomes `done` */
  exitCodes?: number[]
  /** Real process handles for any stage that went through `executeViaExecve`; empty for pure coreutil pipelines */
  processes: JobProcessHandle[]
  /** Resolves once every stage of the pipeline has finished, with its `exitCodes` */
  done: Promise<number[]>
  /** Whether this job was launched with a trailing `&` (vs. promoted to background later) */
  background: boolean
  /** Set once a `Done` notice has been printed at a prompt; the job is then gone from `jobs`, as in bash */
  notified?: boolean
}

/**
 * Run a command the way `Kernel.execute` would, minus the `kernel` field -- `Shell` never holds a
 * `Kernel` reference of its own, so whoever hands it this function closes over `kernel` already.
 */
export type ShellExecute = (options: Omit<KernelExecuteOptions, 'kernel'>) => Promise<number>

/**
 * Joins one pipeline stage's stdout to the next stage's stdin. `Shell` never holds a `Kernel`
 * reference of its own, so whoever constructs it hands over a function already closed over
 * `kernel` -- same pattern as {@link ShellExecute}. Backed by a real `@zenfs/linux` pipe
 * (`Kernel.createPipeStream`), not a plain `TransformStream`, so pipeline stage-to-stage joins go
 * through the same real `pipe` syscall `Kernel.bridgeStdio` already proved out for redirected
 * single-process stdio.
 */
export type ShellCreatePipeStream = () => {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  /** The reading stage has finished: a writer still sending gets `EPIPE` rather than waiting for room that will never come. */
  abandon?: () => void
}

/**
 * The three standard descriptors as a true shell builtin sees them.
 *
 * Builtins used to write straight to `shell.terminal`, which meant their output ignored
 * redirections entirely (`jobs > f` printed to the screen and left `f` empty) and they could not
 * appear in a pipeline at all. Everything a builtin emits or reads now goes through this, so a
 * builtin stage is wired up exactly like any other pipeline stage.
 *
 * Two implementations back it (both in `Shell`): a direct terminal one for the common case of a
 * lone builtin with no redirections, which costs nothing extra and keeps `cd` in a tight loop as
 * cheap as it was; and a stream-backed one over the same `buildOutputStreams` result every
 * `execve`'d command already gets.
 *
 * Kept deliberately text-shaped rather than byte-shaped: builtins deal in lines, and the encoding
 * boundary belongs in one place instead of in fifteen of them.
 */
export interface ShellBuiltinIO {
  /** Whether fd 1 is a terminal, i.e. `isatty(1)` -- `type`/`jobs` colorize only when it is */
  readonly stdoutIsTTY: boolean
  /** Whether fd 0 is a terminal, which is what makes `read` prompt and echo rather than slurp */
  readonly stdinIsTTY: boolean
  /** Write to fd 1 with no trailing newline */
  write(text: string): Promise<void>
  /** Write to fd 1, appending a newline */
  writeln(text: string): Promise<void>
  /** Write to fd 2 with no trailing newline */
  writeErr(text: string): Promise<void>
  /** Write to fd 2, appending a newline */
  writelnErr(text: string): Promise<void>
  /**
   * One line from fd 0 with its trailing newline removed, or `undefined` at EOF. When
   * {@link stdinIsTTY} it prompts and echoes like `readline`; otherwise it reads bytes and both
   * options are ignored, since there is nobody to prompt and nothing echoing.
   */
  readLine(options?: { prompt?: string, silent?: boolean, delimiter?: string, count?: number, timeoutMs?: number, result?: { terminated: boolean, timedOut?: boolean } }): Promise<string | undefined>
  /** Whether `readLine` honors `timeoutMs`. */
  readonly canTimeout?: boolean
  /** Everything left on fd 0. Empty string when there is no stdin at all. */
  readAll(): Promise<string>
  /** Flushes and releases whatever backs this. Called exactly once, after the builtin returns. */
  close(): Promise<void>
}

/**
 * Options for configuring the shell
 */
export interface ShellOptions {
  /** The cross-cutting kernel primitives (i18n is what Shell uses directly) */
  context: KernelContext
  /** Joins pipeline stages together; see {@link ShellCreatePipeStream} */
  createPipeStream: ShellCreatePipeStream
  /** Current working directory */
  cwd?: string
  /** Environment variables */
  env?: Record<string, string>
  /** Run a command; see {@link ShellExecute} */
  execute: ShellExecute
  /** The filesystem, for input-redirection file reads */
  filesystem: Filesystem
  /** The user registry, for resolving the current user's username */
  users: Users
  /** Reference to terminal instance */
  terminal?: Terminal
  /** Called with the shell's own `@zenfs/linux` process when it is created, so the kernel can make it a child of init */
  adoptProcess?: (process: object) => void
}

/**
 * The `set` flags a shell tracks, by their long names.
 *
 * `errexit` (`-e`), `nounset` (`-u`) and `pipefail` (`-o pipefail`) govern how failures propagate;
 * `xtrace` (`-x`) prints each command to stderr behind `$PS4`; `noglob` (`-f`) turns pathname
 * expansion off; `noclobber` (`-C`) stops `>` truncating an existing file; `verbose` (`-v`) echoes
 * input as it is read.
 */
export interface ShellOptionState {
  errexit: boolean
  nounset: boolean
  pipefail: boolean
  xtrace: boolean
  noglob: boolean
  noclobber: boolean
  verbose: boolean
}

/** One of {@link ShellOptionState}'s flags, by name. */
export type ShellOptionName = keyof ShellOptionState

/**
 * Interface for shell functionality
 */
export interface Shell {
  /** Current working directory */
  cwd: string
  /** Environment variables */
  readonly env: Map<string, string>
  /** Environment variables as object */
  readonly envObject: Record<string, string>
  /** Shell ID */
  readonly id: string
  /** Current user's credentials */
  credentials: Credentials
  /** Shell context */
  context: BoundContext
  /** Current username */
  readonly username: string
  /** Terminal */
  terminal: Terminal
  /** Shell configuration */
  readonly config: TerminalConfigManager
  /** The name of a `set` flag; see {@link ShellOptionState} for what each one does. */
  readonly shellOptions: ShellOptionState
  /** Registered `name() { ... }` function bodies, keyed by name */
  readonly functions: Map<string, unknown[]>

  /**
   * Attach terminal to shell
   * @param terminal - Terminal to attach
   */
  attach(terminal: Terminal): void

  /**
   * Clear positional parameters
   */
  clearPositionalParameters(): void

  /**
   * Execute a command
   * @param line - Command line to execute
   */
  execute(line: string): Promise<number>

  /**
   * Set positional parameters
   * @param args - Arguments to set
   */
  setPositionalParameters(args: string[]): void

  /** `$1`, `$2`, ... in order, stopping at the first gap. `$0` is not one of them. */
  readonly positionalParameters: string[]

  /**
   * Runs `text` in this shell the way `source`/`.` and `eval` do: nothing is forked, so variables,
   * functions, `cd` and options all persist afterwards.
   *
   * Unlike {@link executeScriptText} the `EXIT` trap does not run (a sourced file is not a process
   * exiting) and `return` returns from the sourced text rather than escaping.
   * @param text - The text to run
   * @param positional - Replaces `$1..` for the duration (`source f a b`), restored on the way out
   */
  executeSourced(text: string, positional?: string[], file?: string): Promise<number>

  /**
   * Expands tilde (~) to the user's home directory
   * @param input - String that may contain tilde
   * @returns String with tilde expanded to HOME directory
   */
  expandTilde(input: string): string

  /**
   * Runs a full script's text -- potentially spanning multiple lines with `if`/`while`/`for`/
   * `case`/function definitions -- to completion. Used by `Kernel.executeScript` in place of the
   * old flat line-by-line runner.
   * @param script - The script's full text
   */
  executeScriptText(script: string, file?: string): Promise<number>

  /**
   * Sets a variable, honoring an active `local` scope if one exists (writes to the innermost
   * function frame rather than the real environment).
   */
  setVariable(name: string, value: string, append?: boolean): void

  /**
   * Reads `name` the way an expansion does: innermost `local` scope first, then the environment.
   * Returns `undefined` when it is set nowhere, which is how `$IFS` unset (meaning the default
   * ` \t\n`) stays distinguishable from `IFS=` (meaning: do not split).
   */
  lookupVariable(name: string): string | undefined

  /** Whether `name` was marked `readonly`, so an assignment or an unset must be refused. */
  isReadonly(name: string): boolean
  /** Marks `name` readonly. There is deliberately no way back, as in bash. */
  markReadonly(name: string): void
  /** Every readonly name, for `readonly -p`. */
  readonlyNames(): string[]

  /** `alias name='...'` definitions, substituted at command position before a line is parsed. */
  readonly aliases: Map<string, string>

  /**
   * How a command name would be resolved -- the first of alias, keyword, builtin, function or
   * `$PATH` file that claims it, in the order the shell itself checks them. Backs `type` and
   * `command -v`.
   */
  describeCommand(name: string): Promise<{ kind: 'alias' | 'keyword' | 'builtin' | 'function' | 'file', path?: string } | undefined>

  /**
   * `getopts`'s position within the argument it is currently reading, for clustered options like
   * `-abc`. `$OPTIND` counts arguments and cannot express that; assigning `OPTIND=1` resets this too.
   */
  getoptsCharIndex: number

  /** Declares `name` as local to the current function call. Throws outside a function call. */
  declareLocal(name: string, value?: string): void

  /**
   * Every variable visible right now, `local` frames layered over the environment, with the shell's
   * own internal names (`$?`, the positional parameters) left out. What `export -p` and bare `env`
   * list.
   */
  visibleVariables(): Map<string, string>

  /**
   * Publishes this shell's exported environment to `globalThis.process.env`, if this shell is the one
   * that owns that mirror; a no-op for every other shell. `process.env` is a single global and ecmaOS
   * runs one shell per virtual console, so exactly one of them publishes to it.
   */
  publishEnv(): void

  /** Makes this shell the one `globalThis.process.env` mirrors. Called when its TTY becomes active. */
  claimProcessEnv(): void

  /** Applies a `set -e` / `-u` / `-o pipefail` style flag. */
  applyShellOption(flag: ShellOptionName, enabled: boolean): void

  /**
   * Indexed arrays (`a=(x y)`, `${a[@]}`, `${#a[@]}`), keyed by name; never exported to the
   * environment. `local` frames are layered over the shell's own, so this is what is visible now.
   */
  readonly arrays: Map<string, Map<number | string, string>>
  /** Reads one array by name, honoring `local`: the innermost frame declaring it, else the shell's own. */
  lookupArray(name: string): Map<number | string, string> | undefined
  /** Replaces an array's entire contents. */
  setArray(name: string, values: string[]): void
  /** Sets one array element by index, creating the array if needed. */
  setArrayElement(name: string, index: number, value: string): void
  /** Appends elements to an array (`a+=(...)`), creating it if needed. */
  appendArray(name: string, values: string[]): void
  /** Removes one array element by index (`unset a[i]`). */
  unsetArrayElement(name: string, index: number): void
  /** Removes an entire array (`unset a`). */
  unsetArray(name: string): void

  /** `trap 'cmd' SIG`/`trap - SIG`/`trap '' SIG`. Signal names are normalized (`SIGINT` -> `INT`). */
  setTrap(handler: string | undefined, signal: string): void
  /** The handler registered for `signal`, if any. */
  getTrap(signal: string): string | undefined
  /** Every registered trap as `[signal, handler]` pairs, for bare `trap`'s listing. */
  listTraps(): Array<[string, string]>
  /** Runs the handler registered for `signal`, if any (a no-op if none is registered). */
  runTrap(signal: string): Promise<void>

  /** The job currently occupying the foreground, if any -- see {@link Job}'s doc comment for scope. */
  /** Called when `exit` runs at the prompt; the terminal sets it while the built-in shell is a login session. */
  onExit?: (code: number) => void
  readonly foregroundJob: Job | undefined

  /**
   * Whether the line currently running was interrupted by `^C`. The rest of a `;`/`&&`/`||` list
   * and any enclosing loop stop when this is set, as in bash.
   */
  readonly interrupted: boolean

  /**
   * Records that a foreground process was interrupted, and runs any `trap ... INT` handler.
   *
   * Called by the kernel where the signal actually lands, not by the terminal's key handler: while
   * a foreground `execve`'d process holds the terminal, the `@zenfs/linux` line discipline owns the
   * keyboard and turns `^C` into a real `SIGINT` itself (`ISIG`), so the key handler never sees it.
   */
  /** True for the first caller after an interrupt and false for the rest; see `Shell.claimInterrupt` */
  claimInterrupt(): boolean
  notifyInterrupted(): Promise<void>

  /** All tracked jobs (running, stopped, and not-yet-reaped done), oldest first. */
  listJobs(): Job[]
  /** `[n]+  Done  cmd` lines for background jobs that finished since the last prompt; each is reported once */
  takeJobNotifications(): string[]
  /** Whether `PROMPT_COMMAND` has anything to run before the next prompt. */
  hasPromptCommand(): boolean
  /** Runs `PROMPT_COMMAND`; call it just before drawing a primary prompt. */
  runPromptCommand(): Promise<void>

  /**
   * Resolves a job spec the way bash does: `%N` (job N), `%%`/`%+` (current/most recent job),
   * `%-` (previous job), a bare pid (matched against a job's process handles), or `undefined`
   * (defaults to the most recently started job, like bare `fg`/`bg`).
   */
  getJob(spec?: string): Job | undefined

  /**
   * Resumes a stopped job in the foreground (`SIGCONT` to every real process backing it) and waits
   * for it to finish, or promotes an already-running background job to the foreground and waits.
   * @returns the job's last stage's exit code, or `undefined` if no such job exists
   */
  fg(spec?: string): Promise<number | undefined>

  /** Resumes a stopped job in the background (`SIGCONT`) without waiting for it. */
  bg(spec?: string): Job | undefined

  /**
   * Waits for one job/pid (or, with no argument, every currently-tracked background job) to finish.
   * @returns the exit code of the single job/pid waited on, or `undefined` for the no-argument form
   */
  wait(spec?: string): Promise<number | undefined>
}

