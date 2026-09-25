/**
 * Versioned, ordered migrations for a persisted root filesystem.
 *
 * The root filesystem lives in IndexedDB and outlives the kernel that created it, so a new release
 * boots over whatever an older one left behind: command stubs for names that no longer exist, a
 * `/boot/init` written by an older default, files in older formats. Each migration below brings a
 * filesystem from one schema version to the next; `/etc/ecmaos-fs-version` records how far a
 * filesystem has come, so every migration runs exactly once per filesystem.
 *
 * A fresh filesystem has no marker (version 0) and runs them all, which is harmless: each one only
 * touches what it finds.
 */

import type { promises } from '@zenfs/core'

/** Where a filesystem records its schema version. */
export const FS_VERSION_FILE = '/etc/ecmaos-fs-version'

/** The header a legacy in-process command stub starts with (`#!ecmaos:bin:command:<name>`). */
export const COMMAND_STUB_HEADER = '#!ecmaos:bin:command:'

/** A stub is a one-line header; anything bigger under /bin is a real program, never a stub. */
const MAX_STUB_SIZE = 256

/** The programs 1.0 stopped shipping in /bin (they are test fixtures now). */
export const REMOVED_PILOT_PROGRAMS = ['/bin/pilot-pwd.js', '/bin/pilot-window.js']

/** The `/boot/init` a fresh filesystem gets. */
export const DEFAULT_BOOT_INIT = [
  '#!ecmaos:bin:script:init',
  '',
  '# The real, editable boot script -- everything here used to run unconditionally',
  '# inside Kernel.boot() itself. What still can\'t move: anything needing a yes/no',
  '# branch (there is no `if` yet -- see the shell-jobs branch) stays in boot().',
  '# crond isn\'t started here -- a `crond &` line would background it onto this same',
  '# Shell\'s own job table (`_jobs`), the one the interactive session goes on to use, and',
  '# crond never finishes -- so a later bare `wait` (every non-done job) would hang forever.',
  '# It starts the same way /boot/init itself does: a raw Process, not a shell job.',
  'motd',
  'screensaver-daemon',
  ''
].join('\n')

/**
 * Every `/boot/init` an earlier release wrote by default, byte for byte. A filesystem still holding
 * one of these never edited it, so it is safe to replace with the current default.
 */
export const PREVIOUS_DEFAULT_BOOT_INITS: readonly string[] = [
  // 0.1 - 0.2
  '#!ecmaos:script:init\n\n',
  // 0.3 - 0.x: an empty script; boot() itself ran motd, crontab loading and the screensaver daemon
  '#!ecmaos:bin:script:init\n\n',
  // 1.0 pre-release: before crond became a real daemon (load-crontab no longer exists)
  [
    '#!ecmaos:bin:script:init',
    '',
    '# The real, editable boot script -- everything here used to run unconditionally',
    '# inside Kernel.boot() itself. What still can\'t move: anything needing a yes/no',
    '# branch (there is no `if` yet -- see the shell-jobs branch) stays in boot().',
    'motd',
    'load-crontab ~/.config/crontab user',
    'screensaver-daemon',
    ''
  ].join('\n')
]

type Fs = Pick<typeof promises, 'exists' | 'readdir' | 'stat' | 'readFile' | 'writeFile' | 'unlink'>

export interface FsMigrationContext {
  fs: Fs
  log: { info(message: string): void, warn(message: string): void }
  /** Command names still served by the in-process shim; a stub for any other name is stale. */
  legacyCommandNames: ReadonlySet<string>
}

export interface FsMigration {
  /** The schema version a filesystem is at once this migration has run. */
  version: number
  description: string
  run(ctx: FsMigrationContext): Promise<void>
}

/**
 * Deletes every `/bin/<name>` that is a legacy command stub for a name not in `keep`. Such a stub
 * points at an in-process command that no longer exists, so running it can only fail.
 * @returns the names removed
 */
export async function removeStaleCommandStubs(fs: Fs, keep: ReadonlySet<string>): Promise<string[]> {
  if (!await fs.exists('/bin')) return []
  const removed: string[] = []
  for (const name of await fs.readdir('/bin')) {
    if (keep.has(name)) continue
    const path = `/bin/${name}`
    const stat = await fs.stat(path)
    if (!stat.isFile() || stat.size > MAX_STUB_SIZE) continue
    const content = await fs.readFile(path, 'utf8')
    if (!content.startsWith(COMMAND_STUB_HEADER)) continue
    await fs.unlink(path)
    removed.push(name)
  }
  return removed
}

/**
 * Brings `/boot/init` up to the current default if it still holds an older default. A script the
 * user edited is left alone, and the new default is written beside it as `/boot/init.new`.
 */
async function upgradeBootInit(ctx: FsMigrationContext): Promise<void> {
  const { fs, log } = ctx
  if (!await fs.exists('/boot/init')) return // boot() writes the default for a fresh filesystem

  const current = await fs.readFile('/boot/init', 'utf8')
  if (current === DEFAULT_BOOT_INIT) return

  if (PREVIOUS_DEFAULT_BOOT_INITS.includes(current)) {
    await fs.writeFile('/boot/init', DEFAULT_BOOT_INIT)
    log.info('Updated /boot/init to the current default')
    return
  }

  await fs.writeFile('/boot/init.new', DEFAULT_BOOT_INIT)
  log.warn('/boot/init was edited, so it was kept; the new default is in /boot/init.new')
}

export const FS_MIGRATIONS: readonly FsMigration[] = [
  {
    version: 1,
    description: '0.x to 1.0: drop stale command stubs and pilot programs, update /boot/init',
    async run(ctx) {
      const stale = await removeStaleCommandStubs(ctx.fs, ctx.legacyCommandNames)
      if (stale.length) ctx.log.info(`Removed ${stale.length} stale command stub(s) from /bin`)

      for (const path of REMOVED_PILOT_PROGRAMS) {
        if (await ctx.fs.exists(path)) await ctx.fs.unlink(path)
      }

      await upgradeBootInit(ctx)
    }
  }
]

/** The schema version a filesystem is at: 0 if it has never been migrated. */
export async function readFsVersion(fs: Fs): Promise<number> {
  if (!await fs.exists(FS_VERSION_FILE)) return 0
  const version = Number.parseInt((await fs.readFile(FS_VERSION_FILE, 'utf8')).trim(), 10)
  return Number.isFinite(version) ? version : 0
}

/**
 * Runs, in order, every migration newer than the filesystem's recorded version, recording the new
 * version after each one so an interrupted run resumes where it stopped.
 * @returns the versions applied (empty if the filesystem was already current)
 */
export async function runFsMigrations(ctx: FsMigrationContext, migrations: readonly FsMigration[] = FS_MIGRATIONS): Promise<number[]> {
  const applied: number[] = []
  let version = await readFsVersion(ctx.fs)
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= version) continue
    await migration.run(ctx)
    version = migration.version
    await ctx.fs.writeFile(FS_VERSION_FILE, `${version}\n`, { mode: 0o644 })
    applied.push(version)
  }
  return applied
}
