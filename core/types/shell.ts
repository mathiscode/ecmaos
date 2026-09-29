/**
 * Shell types and interfaces
 */

import type { BoundContext, Credentials } from '@zenfs/core'
import type { Filesystem } from './filesystem.ts'
import type { JobProcessHandle, KernelContext, KernelExecuteOptions } from './kernel.ts'
import type { Terminal } from './terminal.ts'
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
export type ShellCreatePipeStream = () => { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> }

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
  readLine(options?: { prompt?: string, silent?: boolean }): Promise<string | undefined>
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
  /** User ID */
  uid: number
  /** Group ID */
  gid: number
}

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
  readonly config: ShellConfigManager
  /** `set -e` / `-u` / `-o pipefail` state; off by default */
  readonly shellOptions: { errexit: boolean, nounset: boolean, pipefail: boolean }
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
   * `shift [N]`: drops the first N positional parameters and renumbers the rest, leaving `$0` alone.
   * @returns false, changing nothing, when N exceeds `$#` -- which is how bash's `shift` fails
   */
  shiftPositionalParameters(count: number): boolean

  /**
   * Runs `text` in this shell the way `source`/`.` and `eval` do: nothing is forked, so variables,
   * functions, `cd` and options all persist afterwards.
   *
   * Unlike {@link executeScriptText} the `EXIT` trap does not run (a sourced file is not a process
   * exiting) and `return` returns from the sourced text rather than escaping.
   * @param text - The text to run
   * @param positional - Replaces `$1..` for the duration (`source f a b`), restored on the way out
   */
  executeSourced(text: string, positional?: string[]): Promise<number>

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
  executeScriptText(script: string): Promise<number>

  /**
   * Sets a variable, honoring an active `local` scope if one exists (writes to the innermost
   * function frame rather than the real environment).
   */
  setVariable(name: string, value: string): void

  /**
   * Reads `name` the way an expansion does: innermost `local` scope first, then the environment.
   * Returns `undefined` when it is set nowhere, which is how `$IFS` unset (meaning the default
   * ` \t\n`) stays distinguishable from `IFS=` (meaning: do not split).
   */
  lookupVariable(name: string): string | undefined

  /** Declares `name` as local to the current function call. Throws outside a function call. */
  declareLocal(name: string, value?: string): void

  /**
   * Removes `name`, honoring `local` scoping: the innermost frame that declared it is marked unset,
   * otherwise it goes from the real environment. Deleting from `env` directly cannot remove a local --
   * the frame keeps shadowing the name while the caller's value is destroyed.
   */
  unsetVariable(name: string): void

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
  applyShellOption(flag: 'errexit' | 'nounset' | 'pipefail', enabled: boolean): void

  /** Indexed arrays (`a=(x y)`, `${a[@]}`, `${#a[@]}`), keyed by name; never exported to the environment. */
  readonly arrays: Map<string, Map<number, string>>
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
  notifyInterrupted(): Promise<void>

  /** All tracked jobs (running, stopped, and not-yet-reaped done), oldest first. */
  listJobs(): Job[]

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

/**
 * Shell configuration
 */
export interface ShellConfig {
  /** Disable the terminal bell */
  noBell?: boolean
  /** Font family for the terminal */
  fontFamily?: string
  /** Font size in pixels */
  fontSize?: number
  /** Whether the cursor should blink */
  cursorBlink?: boolean
  /** Style of the cursor */
  cursorStyle?: 'block' | 'underline' | 'bar'
  /** Terminal theme colors */
  theme?: {
    name?: string
    background?: string
    foreground?: string
    selection?: string
    cursor?: string
    promptColor?: string
  }
  /** Duration of smooth scrolling in milliseconds */
  smoothScrollDuration?: number
  /** Whether Option key on Mac should act as Meta */
  macOptionIsMeta?: boolean
  /**
   * Which xterm.js renderer to use. `webgl` is hardware-accelerated and falls back to `dom`
   * automatically if the WebGL context is lost. `dom` is the escape hatch if WebGL misbehaves
   * with a particular font/GPU combination.
   * @default 'webgl'
   */
  renderer?: 'dom' | 'webgl'
}

/**
 * Shell configuration manager interface
 */
export interface ShellConfigManager extends ShellConfig {
  /**
   * Load configuration
   */
  load(): Promise<void>
  
  /**
   * Set theme
   * @param theme - Theme name or theme object
   */
  setTheme(theme: string | ShellConfig['theme']): void
}
