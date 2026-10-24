/**
 * Modes of the system directories. The initfs extraction creates `/`, `/etc`, `/bin` and `/tmp` as 0777, which
 * matters once programs run as their user. Applied on every boot, only to a listed directory that is world-writable,
 * so a mode the user tightened is kept. Temporary directories only gain the sticky bit.
 */

type Fs = {
  stat(path: string): Promise<{ mode: number }>
  chmod(path: string, mode: number): Promise<void>
}

const STICKY = 0o1000
const WORLD_WRITABLE = 0o002

/** Directories that are world-writable by design: anyone may create files, only an owner may remove theirs. */
export const TEMPORARY_DIRECTORIES: readonly string[] = ['/tmp', '/var/tmp', '/dev/shm']

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
  '/mnt': 0o755,
  '/media': 0o755,
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

/**
 * Programs that run with their owner's privileges, which for these is root's: `su` and `sudo` check who
 * is asking and then start something as someone else, which a user's own program may not do. The kernel
 * honours the bit when it starts a program (see `setuidCredentials`), as Linux does.
 */
export const SETUID_PROGRAMS: readonly string[] = ['/bin/su', '/bin/sudo']

/**
 * Gives the setuid programs their bit, every boot, since a rewritten command file is a fresh one. @returns the
 * programs changed
 */
export async function ensureSetuidPrograms(fs: Fs): Promise<string[]> {
  const changed: string[] = []
  for (const path of SETUID_PROGRAMS) {
    const stats = await fs.stat(path).catch(() => undefined)
    if (!stats || (stats.mode & 0o7777) === 0o4755) continue
    await fs.chmod(path, 0o4755)
    changed.push(path)
  }
  return changed
}

/** Links scripts rely on: link name to the program it names. */
export const CommandLinks: Readonly<Record<string, string>> = {
  '/bin/sh': '/bin/ecmash',
  '/bin/bash': '/bin/ecmash',
  '/usr/bin/env': '/bin/env',
  '/bin/vi': '/bin/vim',
  '/bin/dc': '/bin/bc',
  '/bin/bunzip2': '/bin/bzip2',
  '/bin/bzcat': '/bin/bzip2',
  '/bin/unxz': '/bin/xz',
  '/bin/xzcat': '/bin/xz',
  '/bin/lzma': '/bin/xz',
  '/bin/unlzma': '/bin/xz',
  '/bin/lzcat': '/bin/xz',
  '/bin/unzstd': '/bin/zstd',
  '/bin/zstdcat': '/bin/zstd',
  '/bin/unlz4': '/bin/lz4',
  '/bin/lz4cat': '/bin/lz4',
  '/bin/python': '/bin/python3',
  '/bin/xdg-open': '/bin/open',
  '/bin/pbcopy': '/bin/xclip',
  '/bin/pbpaste': '/bin/xclip',
  '/bin/neofetch': '/bin/fastfetch'
}

/** Names that used to be programs of their own and are links now: a leftover file is replaced by the link. */
export const SupersededPrograms: ReadonlySet<string> = new Set(['/bin/vi'])
