/**
 * `/etc/skel`: the files a new home directory starts with, as on Debian. The defaults are code, not initfs
 * files, because the initfs is unpacked in full only once (an existing system would never see a new one) and
 * a kernel booted without it, as the tests are, still has to make a usable home.
 *
 * Boot fills in what is missing and never overwrites, so an administrator's edit to `/etc/skel` stands. A home
 * directory is filled once, when `useradd -m` creates it; nothing here touches one that already exists.
 */

interface SkelFile { content: string, mode: number }

export const DEFAULT_SKEL: Readonly<Record<string, SkelFile>> = {
  '.profile': {
    mode: 0o644,
    content: `# ~/.profile: read by login shells (after /etc/profile).
# An interactive shell also reads ~/.bashrc, so aliases and prompt settings belong there.

# a private bin directory is searched first when it exists
if [ -d "$HOME/bin" ]; then
  PATH="$HOME/bin:$PATH"
fi
if [ -d "$HOME/.local/bin" ]; then
  PATH="$HOME/.local/bin:$PATH"
fi
`
  },
  '.bashrc': {
    mode: 0o644,
    content: `# ~/.bashrc: read by every interactive shell.

# history: skip lines starting with a space and repeats, keep a generous list
HISTCONTROL=ignoreboth
HISTSIZE=1000
HISTFILESIZE=2000

# colored listings and matches (only on a terminal: auto stays plain in a pipe)
alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias egrep='egrep --color=auto'
alias fgrep='fgrep --color=auto'

# some more ls aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
`
  },
  '.bash_logout': {
    mode: 0o644,
    content: `# ~/.bash_logout: run when a login shell exits.
`
  },
}

/** The structural slice of the file system these functions use. */
export interface SkelFs {
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: { recursive?: boolean, mode?: number }): Promise<unknown>
  writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>
  readFile(path: string, encoding: 'utf-8'): Promise<string>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{ isDirectory(): boolean, mode: number }>
  chown(path: string, uid: number, gid: number): Promise<void>
}

export const SKEL_DIR = '/etc/skel'

/** Writes any default that is missing from `/etc/skel`. */
export async function installSkel(fs: SkelFs): Promise<void> {
  if (!(await fs.exists(SKEL_DIR))) await fs.mkdir(SKEL_DIR, { recursive: true, mode: 0o755 })
  for (const [name, file] of Object.entries(DEFAULT_SKEL)) {
    const path = `${SKEL_DIR}/${name}`
    if (!(await fs.exists(path))) await fs.writeFile(path, file.content, { mode: file.mode })
  }
}

/**
 * Copies `/etc/skel` into `home`, owned by the new user and with the modes it has there. An entry that already
 * exists is left alone. A missing or unreadable skeleton is not an error: the account is still made.
 */
export async function copySkel(fs: SkelFs, home: string, uid: number, gid: number, from: string = SKEL_DIR): Promise<void> {
  let names: string[]
  try { names = await fs.readdir(from) } catch { return }
  for (const name of names) {
    const source = `${from}/${name}`
    const target = `${home}/${name}`
    try {
      const stat = await fs.stat(source)
      if (stat.isDirectory()) {
        if (!(await fs.exists(target))) await fs.mkdir(target, { mode: stat.mode & 0o777 })
        await fs.chown(target, uid, gid)
        await copySkel(fs, target, uid, gid, source)
      } else if (!(await fs.exists(target))) {
        await fs.writeFile(target, await fs.readFile(source, 'utf-8'), { mode: stat.mode & 0o777 })
        await fs.chown(target, uid, gid)
      }
    } catch { /* one unreadable entry must not stop the rest */ }
  }
}
