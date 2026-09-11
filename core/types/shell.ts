/**
 * Shell types and interfaces
 */

import type { BoundContext, Credentials } from '@zenfs/core'
import type { Filesystem } from './filesystem.ts'
import type { KernelContext, KernelExecuteOptions } from './kernel.ts'
import type { Terminal } from './terminal.ts'
import type { Users } from './users.ts'

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
