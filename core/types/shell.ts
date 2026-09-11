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
 * Options for configuring the shell
 */
export interface ShellOptions {
  /** The cross-cutting kernel primitives (i18n is what Shell uses directly) */
  context: KernelContext
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

  /** Declares `name` as local to the current function call. Throws outside a function call. */
  declareLocal(name: string, value?: string): void

  /** Applies a `set -e` / `-u` / `-o pipefail` style flag. */
  applyShellOption(flag: 'errexit' | 'nounset' | 'pipefail', enabled: boolean): void

  /** The job currently occupying the foreground, if any -- see {@link Job}'s doc comment for scope. */
  readonly foregroundJob: Job | undefined

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
