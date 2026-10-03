/**
 * Modes of the system directories.
 *
 * The initfs extraction and the filesystem's own root create `/`, `/etc`, `/bin` and `/tmp` mode 0777,
 * and the boot loop that lays down the rest skips whatever already exists. That never mattered while
 * every program ran as root; once a program runs as its user (see `canRunProgramsAsUser`) a world-writable
 * `/etc` lets any user replace system files, and a `/tmp` without the sticky bit lets one user delete
 * another's files.
 *
 * Applied on every boot, because a fresh boot recreates the 0777 directories each time, and only to a
 * listed directory that is currently world-writable, so a persisted root a user has already tightened
 * is left as they set it. The temporary directories are the opposite case: they are meant to be
 * world-writable, so they only gain the sticky bit.
 */

type Fs = {
  stat(path: string): Promise<{ mode: number }>
  chmod(path: string, mode: number): Promise<void>
}

const STICKY = 0o1000
const WORLD_WRITABLE = 0o002

/** Directories that are world-writable by design: anyone may create files, only an owner may remove theirs. */
export const TEMPORARY_DIRECTORIES: readonly string[] = ['/tmp', '/var/tmp']

/** Every other system directory and the mode it should have when found world-writable. */
export const SYSTEM_DIRECTORY_MODES: Readonly<Record<string, number>> = {
  '/': 0o755,
  '/bin': 0o755,
  '/sbin': 0o755,
  '/boot': 0o755,
  '/lib': 0o755,
  '/opt': 0o755,
  '/etc': 0o755,
  '/etc/default': 0o755,
  '/etc/opt': 0o755,
  '/home': 0o755,
  '/root': 0o700,
  '/run': 0o755,
  '/usr': 0o755,
  '/usr/bin': 0o755,
  '/usr/lib': 0o755,
  '/usr/sbin': 0o755,
  '/usr/share': 0o755,
  '/usr/share/docs': 0o755,
  '/usr/share/licenses': 0o755,
  '/usr/include': 0o755,
  '/usr/local': 0o755,
  '/var': 0o755,
  '/var/cache': 0o755,
  '/var/lib': 0o755,
  '/var/log': 0o755,
  '/var/spool': 0o755,
  '/var/lock': 0o755,
  '/var/opt': 0o755,
  '/var/games': 0o755
}

/** @returns the directories whose mode was changed */
export async function tightenDirectoryModes(fs: Fs): Promise<string[]> {
  const changed: string[] = []
  const permissions = (mode: number) => mode & 0o7777

  for (const path of TEMPORARY_DIRECTORIES) {
    const stats = await fs.stat(path).catch(() => undefined)
    if (!stats || permissions(stats.mode) & STICKY) continue
    await fs.chmod(path, permissions(stats.mode) | STICKY)
    changed.push(path)
  }

  for (const [path, mode] of Object.entries(SYSTEM_DIRECTORY_MODES)) {
    const stats = await fs.stat(path).catch(() => undefined)
    if (!stats || !(permissions(stats.mode) & WORLD_WRITABLE)) continue
    await fs.chmod(path, mode)
    changed.push(path)
  }

  return changed
}

/** Links scripts rely on: link name to the program it names. */
export const CommandLinks: Readonly<Record<string, string>> = {
  '/bin/sh': '/bin/ecmash',
  '/bin/bash': '/bin/ecmash',
  '/usr/bin/env': '/bin/env'
}
