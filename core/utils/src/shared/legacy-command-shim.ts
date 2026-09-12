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

import { meta as metaAwk } from '../commands/awk.js'
import { meta as metaCal } from '../commands/cal.js'
import { meta as metaChown } from '../commands/chown.js'
import { meta as metaCron } from '../commands/cron.js'
import { meta as metaCrypto } from '../commands/crypto.js'
import { meta as metaCurl } from '../commands/curl.js'
import { meta as metaDate } from '../commands/date.js'
import { meta as metaDd } from '../commands/dd.js'
import { meta as metaDiff } from '../commands/diff.js'
import { meta as metaFalse } from '../commands/false.js'
import { meta as metaFetch } from '../commands/fetch.js'
import { meta as metaFind } from '../commands/find.js'
import { meta as metaFmt } from '../commands/fmt.js'
import { meta as metaFormat } from '../commands/format.js'
import { meta as metaGit } from '../commands/git.js'
import { meta as metaGrep } from '../commands/grep.js'
import { meta as metaGroups } from '../commands/groups.js'
import { meta as metaHistory } from '../commands/history.js'
import { meta as metaHostname } from '../commands/hostname.js'
import { meta as metaId } from '../commands/id.js'
import { meta as metaLess } from '../commands/less.js'
import { meta as metaLoadCrontab } from '../commands/load-crontab.js'
import { meta as metaLs } from '../commands/ls.js'
import { meta as metaMan } from '../commands/man.js'
import { meta as metaMotd } from '../commands/motd.js'
import { meta as metaMount } from '../commands/mount.js'
import { meta as metaNc } from '../commands/nc.js'
import { meta as metaNproc } from '../commands/nproc.js'
import { meta as metaOpen } from '../commands/open.js'
import { meta as metaPasskey } from '../commands/passkey.js'
import { meta as metaPlay } from '../commands/play.js'
import { meta as metaPrintf } from '../commands/printf.js'
import { meta as metaPwd } from '../commands/pwd.js'
import { meta as metaScreensaverDaemon } from '../commands/screensaver-daemon.js'
import { meta as metaSed } from '../commands/sed.js'
import { meta as metaSockets } from '../commands/sockets.js'
import { meta as metaSort } from '../commands/sort.js'
import { meta as metaTar } from '../commands/tar.js'
import { meta as metaTest } from '../commands/test.js'
import { meta as metaTheme } from '../commands/theme.js'
import { meta as metaTime } from '../commands/time.js'
import { meta as metaTrue } from '../commands/true.js'
import { meta as metaTty } from '../commands/tty.js'
import { meta as metaUmount } from '../commands/umount.js'
import { meta as metaUname } from '../commands/uname.js'
import { meta as metaUnzip } from '../commands/unzip.js'
import { meta as metaUptime } from '../commands/uptime.js'
import { meta as metaUser } from '../commands/user.js'
import { meta as metaVideo } from '../commands/video.js'
import { meta as metaView } from '../commands/view.js'
import { meta as metaVim } from '../commands/vim.js'
import { meta as metaWeb } from '../commands/web.js'
import { meta as metaWhich } from '../commands/which.js'
import { meta as metaWhoami } from '../commands/whoami.js'
import { meta as metaZip } from '../commands/zip.js'

import { createCommand as createAwk } from '../commands/awk.js'
import { createCommand as createCal } from '../commands/cal.js'
import { createCommand as createChown } from '../commands/chown.js'
import { createCommand as createCron } from '../commands/cron.js'
import { createCommand as createCrypto } from '../commands/crypto.js'
import { createCommand as createCurl } from '../commands/curl.js'
import { createCommand as createDate } from '../commands/date.js'
import { createCommand as createDd } from '../commands/dd.js'
import { createCommand as createDiff } from '../commands/diff.js'
import { createCommand as createFalse } from '../commands/false.js'
import { createCommand as createFetch } from '../commands/fetch.js'
import { createCommand as createFind } from '../commands/find.js'
import { createCommand as createFmt } from '../commands/fmt.js'
import { createCommand as createFormat } from '../commands/format.js'
import { createCommand as createGit } from '../commands/git.js'
import { createCommand as createGrep } from '../commands/grep.js'
import { createCommand as createGroups } from '../commands/groups.js'
import { createCommand as createHistory } from '../commands/history.js'
import { createCommand as createHostname } from '../commands/hostname.js'
import { createCommand as createId } from '../commands/id.js'
import { createCommand as createLess } from '../commands/less.js'
import { createCommand as createLoadCrontab } from '../commands/load-crontab.js'
import { createCommand as createLs } from '../commands/ls.js'
import { createCommand as createMan } from '../commands/man.js'
import { createCommand as createMotd } from '../commands/motd.js'
import { createCommand as createMount } from '../commands/mount.js'
import { createCommand as createNc } from '../commands/nc.js'
import { createCommand as createNproc } from '../commands/nproc.js'
import { createCommand as createOpen } from '../commands/open.js'
import { createCommand as createPasskey } from '../commands/passkey.js'
import { createCommand as createPlay } from '../commands/play.js'
import { createCommand as createPrintf } from '../commands/printf.js'
import { createCommand as createPwd } from '../commands/pwd.js'
import { createCommand as createScreensaverDaemon } from '../commands/screensaver-daemon.js'
import { createCommand as createSed } from '../commands/sed.js'
import { createCommand as createSockets } from '../commands/sockets.js'
import { createCommand as createSort } from '../commands/sort.js'
import { createCommand as createTar } from '../commands/tar.js'
import { createCommand as createTest } from '../commands/test.js'
import { createCommand as createTheme } from '../commands/theme.js'
import { createCommand as createTime } from '../commands/time.js'
import { createCommand as createTrue } from '../commands/true.js'
import { createCommand as createTty } from '../commands/tty.js'
import { createCommand as createUmount } from '../commands/umount.js'
import { createCommand as createUname } from '../commands/uname.js'
import { createCommand as createUnzip } from '../commands/unzip.js'
import { createCommand as createUptime } from '../commands/uptime.js'
import { createCommand as createUser } from '../commands/user.js'
import { createCommand as createVideo } from '../commands/video.js'
import { createCommand as createView } from '../commands/view.js'
import { createCommand as createVim } from '../commands/vim.js'
import { createCommand as createWeb } from '../commands/web.js'
import { createCommand as createWhich } from '../commands/which.js'
import { createCommand as createWhoami } from '../commands/whoami.js'
import { createCommand as createZip } from '../commands/zip.js'

export type CreateCommandFn = (kernel: Kernel, shell: Shell, terminal: Terminal) => TerminalCommand

export interface LegacyCommandEntry {
  description: string
  createCommand: CreateCommandFn
}

export type LegacyCommands = Record<string, LegacyCommandEntry>

function buildLegacyCommands(): LegacyCommands {
  return {
  "awk": { description: metaAwk.description, createCommand: createAwk },
  "cal": { description: metaCal.description, createCommand: createCal },
  "chown": { description: metaChown.description, createCommand: createChown },
  "cron": { description: metaCron.description, createCommand: createCron },
  "crypto": { description: metaCrypto.description, createCommand: createCrypto },
  "curl": { description: metaCurl.description, createCommand: createCurl },
  "date": { description: metaDate.description, createCommand: createDate },
  "dd": { description: metaDd.description, createCommand: createDd },
  "diff": { description: metaDiff.description, createCommand: createDiff },
  "false": { description: metaFalse.description, createCommand: createFalse },
  "fetch": { description: metaFetch.description, createCommand: createFetch },
  "find": { description: metaFind.description, createCommand: createFind },
  "fmt": { description: metaFmt.description, createCommand: createFmt },
  "format": { description: metaFormat.description, createCommand: createFormat },
  "git": { description: metaGit.description, createCommand: createGit },
  "grep": { description: metaGrep.description, createCommand: createGrep },
  "groups": { description: metaGroups.description, createCommand: createGroups },
  "history": { description: metaHistory.description, createCommand: createHistory },
  "hostname": { description: metaHostname.description, createCommand: createHostname },
  "id": { description: metaId.description, createCommand: createId },
  "less": { description: metaLess.description, createCommand: createLess },
  "load-crontab": { description: metaLoadCrontab.description, createCommand: createLoadCrontab },
  "ls": { description: metaLs.description, createCommand: createLs },
  "man": { description: metaMan.description, createCommand: createMan },
  "motd": { description: metaMotd.description, createCommand: createMotd },
  "mount": { description: metaMount.description, createCommand: createMount },
  "nc": { description: metaNc.description, createCommand: createNc },
  "nproc": { description: metaNproc.description, createCommand: createNproc },
  "open": { description: metaOpen.description, createCommand: createOpen },
  "passkey": { description: metaPasskey.description, createCommand: createPasskey },
  "play": { description: metaPlay.description, createCommand: createPlay },
  "printf": { description: metaPrintf.description, createCommand: createPrintf },
  "pwd": { description: metaPwd.description, createCommand: createPwd },
  "screensaver-daemon": { description: metaScreensaverDaemon.description, createCommand: createScreensaverDaemon },
  "sed": { description: metaSed.description, createCommand: createSed },
  "sockets": { description: metaSockets.description, createCommand: createSockets },
  "sort": { description: metaSort.description, createCommand: createSort },
  "tar": { description: metaTar.description, createCommand: createTar },
  "test": { description: metaTest.description, createCommand: createTest },
  "theme": { description: metaTheme.description, createCommand: createTheme },
  "time": { description: metaTime.description, createCommand: createTime },
  "true": { description: metaTrue.description, createCommand: createTrue },
  "tty": { description: metaTty.description, createCommand: createTty },
  "umount": { description: metaUmount.description, createCommand: createUmount },
  "uname": { description: metaUname.description, createCommand: createUname },
  "unzip": { description: metaUnzip.description, createCommand: createUnzip },
  "uptime": { description: metaUptime.description, createCommand: createUptime },
  "user": { description: metaUser.description, createCommand: createUser },
  "video": { description: metaVideo.description, createCommand: createVideo },
  "view": { description: metaView.description, createCommand: createView },
  "vim": { description: metaVim.description, createCommand: createVim },
  "web": { description: metaWeb.description, createCommand: createWeb },
  "which": { description: metaWhich.description, createCommand: createWhich },
  "whoami": { description: metaWhoami.description, createCommand: createWhoami },
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
