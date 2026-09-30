/**
 * Who is logged in, and who has been: `/run/utmp` and `/var/log/wtmp`.
 *
 * ecmaOS has up to eight virtual consoles, each with its own login, so "who is on which tty" is a
 * real question with a real answer; until now nothing recorded it. The formats are text, one record
 * per line and tab-separated, where Linux's are binary `struct utmp` records. Nothing outside
 * `who` and `last` reads them, and a script can `cut` a text file.
 *
 * - `/run/utmp`: `user<TAB>ttyN<TAB>epoch-ms`, one line per console with a login *now*. Emptied at
 *   boot, since `/run` is meant to be volatile and a persisted root would otherwise show the
 *   previous boot's sessions as current.
 * - `/var/log/wtmp`: `login<TAB>user<TAB>ttyN<TAB>epoch-ms` for every login, and
 *   `boot<TAB>~<TAB>system boot<TAB>epoch-ms` for every boot. There is no logout record: a console
 *   session ends when the page does, and nothing runs then. `last` ends a session at the next boot
 *   line instead, and says so.
 *
 * Written with the kernel's own filesystem handle (root), not the logging-in user's: a user cannot
 * write `/run` and must not be able to edit `wtmp`.
 */

export interface SessionFs {
  exists(path: string): Promise<boolean>
  readFile(path: string, encoding: 'utf-8'): Promise<string>
  writeFile(path: string, data: string, encoding: 'utf-8'): Promise<void>
}

export const UTMP = '/run/utmp'
export const WTMP = '/var/log/wtmp'

export class SessionLog {
  /** Records are written one at a time: two consoles logging in together must not interleave a read and a write. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly fs: SessionFs, private readonly now: () => number = Date.now) {}

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }

  /**
   * Appends by reading and rewriting, not `appendFile`: on a freshly created file `appendFile`
   * wrote the second record over the first and left a run of NUL bytes where it had been.
   */
  private async append(path: string, line: string): Promise<void> {
    const before = (await this.fs.exists(path)) ? await this.fs.readFile(path, 'utf-8') : ''
    await this.fs.writeFile(path, before + line, 'utf-8')
  }

  /** Empties `utmp` and marks the start of a boot in `wtmp`. */
  boot(): Promise<void> {
    return this.serialized(async () => {
      await this.fs.writeFile(UTMP, '', 'utf-8')
      await this.append(WTMP, `boot\t~\tsystem boot\t${this.now()}\n`)
    })
  }

  /** Records `user` as the login on console `tty`, replacing whoever was there (`su` does this too). */
  login(user: string, tty: number): Promise<void> {
    return this.serialized(() => this.record(user, tty))
  }

  private async record(user: string, tty: number): Promise<void> {
    const name = `tty${tty}`
    const time = this.now()
    let lines: string[] = []
    if (await this.fs.exists(UTMP)) {
      lines = (await this.fs.readFile(UTMP, 'utf-8')).split('\n').filter(Boolean)
        .filter(line => line.split('\t')[1] !== name)
    }
    lines.push(`${user}\t${name}\t${time}`)
    lines.sort((a, b) => a.split('\t')[1]!.localeCompare(b.split('\t')[1]!, undefined, { numeric: true }))
    await this.fs.writeFile(UTMP, lines.join('\n') + '\n', 'utf-8')
    await this.append(WTMP, `login\t${user}\t${name}\t${time}\n`)
  }
}
