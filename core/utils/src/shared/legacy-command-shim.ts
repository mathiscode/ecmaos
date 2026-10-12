/**
 * The three coreutils that still run as in-process closures (`TerminalCommand`): `true`, `false` and `test`. They
 * stay in-process because they are the condition of tight shell loops, where a worker start-up per iteration is slow.
 * Every other command is a program under `/bin`; shell builtins are in `core/kernel/src/tree/lib/shell-builtins.ts`.
 * `resolveLegacyCommand` (called by `Kernel.executeCommand`) constructs the one command invoked, cached per
 * `Terminal` in a `WeakMap`.
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

/** The full legacy-shim source list, built once and memoized - never rebuilt per-`Terminal`/per-TTY. */
export function getLegacyCommands(): LegacyCommands {
  cached ??= buildLegacyCommands()
  return cached
}

/**
 * A legacy command's `TerminalCommand`, constructed on first use and cached per `Terminal`. `undefined` for any other
 * name; `Kernel.executeCommand` calls it only after file resolution and the builtin check miss.
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
