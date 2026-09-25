/**
 * The legacy-command shim: the three coreutils that still run as in-process JS closures
 * (`TerminalCommand`) instead of real `execve`'d files -- `true`, `false` and `test`.
 *
 * Every other command is a real program: a file under `/bin` that `readFileHeader`/`execve`
 * resolve the same way bash resolves `/bin/ls`, with no table entry anywhere. These three stay
 * in-process on purpose: they are the usual condition of a tight shell loop
 * (`while test ...; do ...; done`), and a real `execve` costs a worker start-up per iteration, a
 * measurable slowdown for exactly the pattern they are used in most.
 *
 * True shell builtins (cd, set, bg, fg, jobs, wait, local, env) are not here either: they live in
 * `core/kernel/src/tree/lib/shell-builtins.ts`, a dispatch table on `Shell` checked before any
 * file resolution.
 *
 * `resolveLegacyCommand` is what `Kernel.executeCommand` calls -- lazily constructing the ONE
 * `TerminalCommand` actually invoked, cached per-`Terminal` (one per TTY) via a `WeakMap` keyed
 * by the live `Terminal` object itself, so it's impossible for one TTY's cached command to leak
 * into another's, and the cache self-cleans once that `Terminal` is garbage-collected.
 */

import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { TerminalCommand } from './terminal-command.js'

import { meta as metaFalse } from '../commands/false.js'
import { meta as metaTest } from '../commands/test.js'
import { meta as metaTrue } from '../commands/true.js'

import { createCommand as createFalse } from '../commands/false.js'
import { createCommand as createTest } from '../commands/test.js'
import { createCommand as createTrue } from '../commands/true.js'

export type CreateCommandFn = (kernel: Kernel, shell: Shell, terminal: Terminal) => TerminalCommand

export interface LegacyCommandEntry {
  description: string
  createCommand: CreateCommandFn
}

export type LegacyCommands = Record<string, LegacyCommandEntry>

function buildLegacyCommands(): LegacyCommands {
  return {
  "false": { description: metaFalse.description, createCommand: createFalse },
  "test": { description: metaTest.description, createCommand: createTest },
  "true": { description: metaTrue.description, createCommand: createTrue },
  }
}

let cached: LegacyCommands | undefined

/** The full legacy-shim source list, built once and memoized -- never rebuilt per-`Terminal`/per-TTY. */
export function getLegacyCommands(): LegacyCommands {
  cached ??= buildLegacyCommands()
  return cached
}

/**
 * A legacy command's `TerminalCommand` object, constructed lazily on first invocation and cached
 * thereafter -- keyed by the live `Terminal` instance itself (one per TTY), not a derived string,
 * so it is impossible for one TTY's cached command to leak into another's.
 *
 * Returns `undefined` for a name this list does not know (an execve'd command, a true builtin, or
 * simply unknown) -- `Kernel.executeCommand` should only ever call this as a last resort, after
 * real file resolution and the true-builtin check have both already missed.
 */
const legacyCommandCache = new WeakMap<Terminal, Map<string, TerminalCommand>>()

export function resolveLegacyCommand(kernel: Kernel, shell: Shell, terminal: Terminal, name: string): TerminalCommand | undefined {
  const entry = getLegacyCommands()[name]
  if (!entry) return undefined

  let perTerminal = legacyCommandCache.get(terminal)
  if (!perTerminal) {
    perTerminal = new Map()
    legacyCommandCache.set(terminal, perTerminal)
  }

  let command = perTerminal.get(name)
  if (!command) {
    command = entry.createCommand(kernel, shell, terminal)
    perTerminal.set(name, command)
  }

  return command
}
