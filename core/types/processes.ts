/**
 * Types for programs started by the kernel.
 *
 * Processes themselves are `@zenfs/linux` `Process`es created by `execve`; ecmaOS no longer has a
 * process class of its own. What remains here is the entry-point contract a DOM app (`/bin/app`)
 * receives.
 */

import type { Kernel } from './kernel.ts'
import type { Shell } from './shell.ts'
import type { Terminal } from './terminal.ts'

/**
 * ZenFS FileHandle interface
 * @see https://zenfs.dev/core/classes/index.fs.promises.FileHandle.html
 */
export interface FileHandle {
  /** The numeric file descriptor */
  readonly fd: number
  /** Close the file handle */
  close(): Promise<void>
  /** Read file contents */
  readFile(encoding?: BufferEncoding): Promise<string | Buffer>
  /** Write data to file */
  writeFile(data: string | Uint8Array): Promise<void>
  /** Truncate file to specified length */
  truncate(len?: number): Promise<void>
  /** Get a readable web stream */
  readableWebStream?(options?: { type?: 'bytes' }): ReadableStream<Uint8Array>
  /** Get a writable web stream */
  writableWebStream?(): WritableStream<Uint8Array>
}

/**
 * What an in-process command (the legacy shim that still runs `true`/`false`/`test`) gets in place of
 * a process: no process-table entry, just its stdio and whether each end is a terminal.
 */
export interface CommandInvocation {
  readonly pid: number
  readonly command: string
  readonly args: string[]
  readonly uid: number
  readonly gid: number
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: WritableStream<Uint8Array>
  readonly stderr: WritableStream<Uint8Array>
  /** Whether stdin is a TTY (interactive terminal) vs a pipe */
  readonly stdinIsTTY?: boolean
  /** Whether stdout is a TTY (interactive terminal) vs a file/pipe */
  readonly stdoutIsTTY?: boolean
}

/**
 * The `instance` an app's entry point receives from the `/bin/app` presenter: a small handle on the
 * app's own process lifetime.
 */
export interface ProcessInstance {
  /**
   * Open a file
   * @param path - Path to the file
   * @param flags - Open flags (default: 'r')
   */
  open(path: string, flags?: string): Promise<FileHandle>
  /** End the process with the given exit code (default 0) */
  exit(code?: number): void
  /**
   * Keep the process alive after the entry function returns, until `exit` is called. For apps whose
   * window outlives `main` (an editor, a player).
   */
  keepAlive(): void
  /**
   * Registers a callback run if the process ends from outside (`^C`, `kill`) rather than by calling
   * `exit()` itself -- the app's chance to close whatever window it opened.
   */
  onDispose(callback: () => void): void
}

/**
 * Parameters passed to an app's entry point
 */
export interface ProcessEntryParams {
  /** Process ID */
  pid: number
  /** User ID */
  uid: number
  /** Group ID */
  gid: number
  /** Command line arguments */
  args: string[]
  /** Command name */
  command: string
  /** Working directory */
  cwd: string
  /** The app's own process lifetime handle */
  instance: ProcessInstance
  /** Reference to kernel instance */
  kernel: Kernel
  /** Reference to shell instance */
  shell: Shell
  /** Reference to terminal instance */
  terminal: Terminal
  /** Standard input stream */
  stdin?: ReadableStream<Uint8Array>
  /** Whether stdin is a TTY (interactive terminal) vs a pipe */
  stdinIsTTY?: boolean
  /** Standard output stream */
  stdout?: WritableStream<Uint8Array>
  /** Whether stdout is a TTY (interactive terminal) vs a file/pipe */
  stdoutIsTTY?: boolean
  /** Standard error stream */
  stderr?: WritableStream<Uint8Array>
}
