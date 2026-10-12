/**
 * Which files a shell runs when it starts, and in what order. Both hosts (the kernel `Shell` and the
 * `/bin/ecmash` program) ask this one function, so they cannot disagree about it.
 *
 * Login shells read the system profile, every `*.sh` in `/etc/profile.d`, and then the first of the
 * user's profile files that exists - bash's rule, so a `~/.bash_profile` can suppress `~/.profile`
 * rather than adding to it. An interactive shell then reads the per-shell files, which unlike the
 * profile ones all run: `/etc/ecmashrc`, `~/.bashrc`, `~/.ecmashrc`.
 *
 * The bash names are read by both shells because that is where a Linux user's habits already put
 * things. The `ecmash` names stay supported, so an existing `~/.ecmashrc` keeps working unchanged.
 */

export interface StartupHost {
  /** Whether `path` exists and is a file. */
  isFile(path: string): boolean | Promise<boolean>
  /** The names (not paths) in `dir`, or an empty list when it cannot be read. */
  list(dir: string): string[] | Promise<string[]>
}

export interface StartupOptions {
  /** `HOME` of the user starting the shell; user files are skipped without it. */
  home?: string
  /** A login shell: reads the profile files. */
  login: boolean
  /** An interactive shell: reads the per-shell rc files. */
  interactive: boolean
}

/** The user's profile files, in the order bash prefers them; only the first that exists is read. */
export const USER_PROFILE_FILES = ['.bash_profile', '.ecmash_profile', '.profile']

/** The user's per-shell files, all read in this order after the system one. */
export const USER_RC_FILES = ['.bashrc', '.ecmashrc']

export const SYSTEM_PROFILE = '/etc/profile'
export const SYSTEM_PROFILE_DIR = '/etc/profile.d'
export const SYSTEM_RC = '/etc/ecmashrc'

const join = (dir: string, name: string): string => (dir.endsWith('/') ? dir : `${dir}/`) + name

/** The files to run, in order, that exist. */
export async function startupFiles(options: StartupOptions, host: StartupHost): Promise<string[]> {
  const files: string[] = []
  const home = options.home && options.home !== '' ? options.home : undefined
  const safeIsFile = async (path: string): Promise<boolean> => {
    try { return await host.isFile(path) } catch { return false }
  }

  if (options.login) {
    if (await safeIsFile(SYSTEM_PROFILE)) files.push(SYSTEM_PROFILE)

    let names: string[] = []
    try { names = await host.list(SYSTEM_PROFILE_DIR) } catch { /* no profile.d */ }
    for (const name of [...names].filter(entry => entry.endsWith('.sh')).sort()) {
      const path = join(SYSTEM_PROFILE_DIR, name)
      if (await safeIsFile(path)) files.push(path)
    }

    if (home) {
      for (const name of USER_PROFILE_FILES) {
        const path = join(home, name)
        if (await safeIsFile(path)) { files.push(path); break }
      }
    }
  }

  if (options.interactive) {
    if (await safeIsFile(SYSTEM_RC)) files.push(SYSTEM_RC)
    if (home) {
      for (const name of USER_RC_FILES) {
        const path = join(home, name)
        if (await safeIsFile(path)) files.push(path)
      }
    }
  }

  return files
}
