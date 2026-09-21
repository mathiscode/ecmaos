/**
 * The legacy-command shim: a source list, built once, of every coreutil that still runs as an
 * in-process JS closure (`TerminalCommand`) rather than a real `execve`'d file -- NOT a
 * permanent registry. Real Linux has no such thing: `execve`+`$PATH` resolve a command purely
 * off real files on disk, and this shim exists only because most of ecmaOS's coreutils predate
 * `execve` working at all and still reach live `kernel`/`shell`/`terminal` object references a
 * real worker cannot see. As more commands migrate to `core/utils/src/commands-execve/*.mjs`
 * (see that directory, and `vite-plugin-bin-node.ts`'s `migratedCommands`), this list shrinks --
 * it is not meant to be "finished" by growing to cover everything forever.
 *
 * Excludes two categories on purpose:
 * - The 45 already-`execve`-migrated names (echo, basename, dirname, tr, mkdir, rm, cp, mv,
 *   touch, chmod, cat, head, tail, wc, nl, rev, tac, uniq, cut, fold, expand, unexpand, cksum,
 *   strings, xxd, od, hash, cmp, comm, column, seq, factor, rmdir, join, paste, sleep, mktemp,
 *   shuf, split, pr, tee, stat, readlink, realpath, ln): real files under /bin already resolve them
 *   via `readFileHeader`/`execve` -- they need no entry here at all, the same way bash needs no
 *   table entry for a real `/bin/ls`.
 * - True shell builtins (cd, set, bg, fg, jobs, wait, local, env -- see
 *   `core/kernel/src/tree/lib/shell-builtins.ts`'s own doc comment for why these can never
 *   become real files): they moved to a small, permanent, in-process dispatch table on `Shell`
 *   itself, checked before any file-based resolution happens at all.
 *
 * `resolveLegacyCommand` is what `Kernel.executeCommand` calls -- lazily constructing the ONE
 * `TerminalCommand` actually invoked, cached per-`Terminal` (one per TTY) via a `WeakMap` keyed
 * by the live `Terminal` object itself, so it's impossible for one TTY's cached command to leak
 * into another's, and the cache self-cleans once that `Terminal` is garbage-collected.
 */

import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { TerminalCommand } from './terminal-command.js'

import { meta as metaFalse } from '../commands/false.js'
import { meta as metaGit } from '../commands/git.js'
import { meta as metaLess } from '../commands/less.js'
import { meta as metaMan } from '../commands/man.js'
import { meta as metaMount } from '../commands/mount.js'
import { meta as metaNc } from '../commands/nc.js'
import { meta as metaOpen } from '../commands/open.js'
import { meta as metaPasskey } from '../commands/passkey.js'
import { meta as metaPlay } from '../commands/play.js'
import { meta as metaScreensaverDaemon } from '../commands/screensaver-daemon.js'
import { meta as metaTest } from '../commands/test.js'
import { meta as metaTrue } from '../commands/true.js'
import { meta as metaUnzip } from '../commands/unzip.js'
import { meta as metaVideo } from '../commands/video.js'
import { meta as metaView } from '../commands/view.js'
import { meta as metaVim } from '../commands/vim.js'
import { meta as metaWeb } from '../commands/web.js'
import { meta as metaZip } from '../commands/zip.js'

import { createCommand as createFalse } from '../commands/false.js'
import { createCommand as createGit } from '../commands/git.js'
import { createCommand as createLess } from '../commands/less.js'
import { createCommand as createMan } from '../commands/man.js'
import { createCommand as createMount } from '../commands/mount.js'
import { createCommand as createNc } from '../commands/nc.js'
import { createCommand as createOpen } from '../commands/open.js'
import { createCommand as createPasskey } from '../commands/passkey.js'
import { createCommand as createPlay } from '../commands/play.js'
import { createCommand as createScreensaverDaemon } from '../commands/screensaver-daemon.js'
import { createCommand as createTest } from '../commands/test.js'
import { createCommand as createTrue } from '../commands/true.js'
import { createCommand as createUnzip } from '../commands/unzip.js'
import { createCommand as createVideo } from '../commands/video.js'
import { createCommand as createView } from '../commands/view.js'
import { createCommand as createVim } from '../commands/vim.js'
import { createCommand as createWeb } from '../commands/web.js'
import { createCommand as createZip } from '../commands/zip.js'

export type CreateCommandFn = (kernel: Kernel, shell: Shell, terminal: Terminal) => TerminalCommand

export interface LegacyCommandEntry {
  description: string
  createCommand: CreateCommandFn
}

export type LegacyCommands = Record<string, LegacyCommandEntry>

function buildLegacyCommands(): LegacyCommands {
  return {
  "false": { description: metaFalse.description, createCommand: createFalse },
  "git": { description: metaGit.description, createCommand: createGit },
  "less": { description: metaLess.description, createCommand: createLess },
  "man": { description: metaMan.description, createCommand: createMan },
  "mount": { description: metaMount.description, createCommand: createMount },
  "nc": { description: metaNc.description, createCommand: createNc },
  "open": { description: metaOpen.description, createCommand: createOpen },
  "passkey": { description: metaPasskey.description, createCommand: createPasskey },
  "play": { description: metaPlay.description, createCommand: createPlay },
  "screensaver-daemon": { description: metaScreensaverDaemon.description, createCommand: createScreensaverDaemon },
  "test": { description: metaTest.description, createCommand: createTest },
  "true": { description: metaTrue.description, createCommand: createTrue },
  "unzip": { description: metaUnzip.description, createCommand: createUnzip },
  "video": { description: metaVideo.description, createCommand: createVideo },
  "view": { description: metaView.description, createCommand: createView },
  "vim": { description: metaVim.description, createCommand: createVim },
  "web": { description: metaWeb.description, createCommand: createWeb },
  "zip": { description: metaZip.description, createCommand: createZip },
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
 * `extra` lets a caller merge in a second source of legacy commands this shim doesn't itself know
 * about -- `@ecmaos/kernel`'s own kernel-native legacy commands (`getKernelLegacyCommands()`,
 * `core/kernel/src/tree/lib/commands/index.ts`), which can't live in `@ecmaos/coreutils` since they
 * reach kernel-only state/DOM APIs. Checked only if `name` isn't found in this module's own list.
 *
 * Returns `undefined` for a name neither source knows (an execve'd command, a true builtin, or
 * simply unknown) -- `Kernel.executeCommand` should only ever call this as a last resort, after
 * real file resolution and the true-builtin check have both already missed.
 */
const legacyCommandCache = new WeakMap<Terminal, Map<string, TerminalCommand>>()

export function resolveLegacyCommand(kernel: Kernel, shell: Shell, terminal: Terminal, name: string, extra?: LegacyCommands): TerminalCommand | undefined {
  const entry = getLegacyCommands()[name] ?? extra?.[name]
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
