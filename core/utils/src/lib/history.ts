/**
 * Command history, per user, backed by a file. Holds the list in memory (bounded by `HISTSIZE`) after one read,
 * appends without reading back, trims the file to `HISTFILESIZE` and follows `HISTCONTROL`. Filesystem and variables
 * come in through {@link HistoryHost}, so a worker shell can use it.
 */

/** The small slice of the filesystem this needs. */
export interface HistoryFs {
  exists(path: string): Promise<boolean>
  readFile(path: string, encoding: 'utf-8'): Promise<string>
  writeFile(path: string, data: string, encoding: 'utf-8'): Promise<void>
}

export interface HistoryHost {
  /** The filesystem, or undefined while it is not ready yet (early boot). */
  fs(): HistoryFs | undefined
  /** Where `uid`'s history lives. */
  file(uid: number): string
  /** A shell variable, for `HISTSIZE`, `HISTFILESIZE` and `HISTCONTROL`. */
  variable(name: string): string | undefined
  /** Reports a failure that is worth a log line; a missing file or filesystem is not one. */
  error(message: string): void
}

/** bash's defaults. */
export const DEFAULT_HISTSIZE = 1000
export const DEFAULT_HISTFILESIZE = 2000

interface UserHistory {
  entries: string[]
  /** How many lines the file holds, which can exceed `entries` after a `HISTSIZE` cut. */
  fileLines: number
  /** Where ArrowUp/ArrowDown currently are; `entries.length` means "the line being typed". */
  position: number
  loaded: boolean
  /**
   * Whether the file ends in a newline. Files from earlier versions do not, so appending without checking would join
   * two commands.
   */
  terminated: boolean
  /**
   * The file's content as held in memory. Every save rewrites the file from this, since `appendFile` on the root
   * filesystem writes each chunk at offset 0.
   */
  text: string
}

export class History {
  private readonly users = new Map<number, UserHistory>()

  constructor(private readonly host: HistoryHost) {}

  private of(uid: number): UserHistory {
    let user = this.users.get(uid)
    if (!user) {
      user = { entries: [], fileLines: 0, position: 0, loaded: false, terminated: true, text: '' }
      this.users.set(uid, user)
    }
    return user
  }

  private limit(name: string, fallback: number): number {
    const raw = this.host.variable(name)
    if (raw === undefined || raw === '') return fallback
    const value = Number.parseInt(raw, 10)
    // Negative means unlimited in bash; zero means keep nothing.
    return Number.isFinite(value) ? (value < 0 ? Number.POSITIVE_INFINITY : value) : fallback
  }

  /** Reads `uid`'s file once and trims it to `HISTFILESIZE`. Safe to call repeatedly; `force` re-reads. */
  async load(uid: number, force = false): Promise<void> {
    const user = this.of(uid)
    if (user.loaded && !force) return

    const fs = this.host.fs()
    if (!fs) return

    user.entries = []
    user.fileLines = 0
    user.terminated = true
    user.text = ''
    // A file that is not there yet is not cached as empty: the filesystem can still be coming up (the kernel's terminal
    // loads before boot has mounted the root), and `add` would then write over the real file with the new commands alone.
    let found = false
    try {
      const file = this.host.file(uid)
      if (await fs.exists(file)) {
        found = true
        // NUL bytes are what a file damaged by the `appendFile` bug holds; dropping them heals it.
        const content = (await fs.readFile(file, 'utf-8')).replaceAll('\0', '')
        user.terminated = content.length === 0 || content.endsWith('\n')
        let lines = content.split('\n').filter(line => line.length > 0)

        const fileMax = this.limit('HISTFILESIZE', DEFAULT_HISTFILESIZE)
        if (lines.length > fileMax) {
          lines = lines.slice(lines.length - fileMax)
          await fs.writeFile(file, lines.length ? lines.join('\n') + '\n' : '', 'utf-8')
          user.terminated = true
        }

        user.text = lines.length ? lines.join('\n') + '\n' : ''
        user.terminated = true
        user.fileLines = lines.length
        user.entries = lines.slice(Math.max(0, lines.length - this.limit('HISTSIZE', DEFAULT_HISTSIZE)))
      }
    } catch (error) {
      this.report(error, 'load')
    }

    user.position = user.entries.length
    user.loaded = found
  }

  private report(error: unknown, action: string) {
    const err = error as { code?: string, message?: string }
    if (err.code === 'ENOENT' || err.message?.includes('No file system')) return
    this.host.error(`history ${action}: ${error instanceof Error ? error.message : String(error)}`)
  }

  /** Every entry for `uid`, oldest first. */
  entries(uid: number): readonly string[] { return this.of(uid).entries }
  get(uid: number, index: number): string | undefined { return this.of(uid).entries[index] }
  length(uid: number): number { return this.of(uid).entries.length }

  position(uid: number): number { return this.of(uid).position }
  setPosition(uid: number, position: number) {
    const user = this.of(uid)
    user.position = Math.max(0, Math.min(position, user.entries.length))
  }
  /** Moves back to "the line being typed", as after running a command. */
  resetPosition(uid: number) { this.setPosition(uid, this.length(uid)) }

  /**
   * Whether `command` should be recorded under `HISTCONTROL`: `ignorespace`, `ignoredups`, `ignoreboth`, and
   * `erasedups` (handled in {@link add}). Unset means `ignorespace` and `ignoredups`.
   */
  private accepts(user: UserHistory, command: string, control: Set<string>): boolean {
    if (command.trim().length === 0) return false
    if ((control.has('ignorespace') || control.has('ignoreboth')) && command.startsWith(' ')) return false
    if ((control.has('ignoredups') || control.has('ignoreboth')) && user.entries[user.entries.length - 1] === command) return false
    return true
  }

  /**
   * A multi-line command as one history line, joined with `;` as bash's `cmdhist` does. A heredoc cannot be joined
   * and is not recorded.
   */
  private flatten(command: string): string | undefined {
    if (!command.includes('\n')) return command
    if (/<<-?\s*['"]?\w/.test(command)) return undefined
    let joined = ''
    for (const line of command.split('\n').map(line => line.trim()).filter(Boolean)) {
      // A line that opens a block takes the next one with a space: `do; echo` is not valid shell,
      // `do echo` is. Everything else is a new command and gets the `;`.
      const opens = /(?:^|[\s;({&|])(?:do|then|else|\{|\(|in)$|&&$|\|\|$|\|$|\\$/.test(joined)
      joined = joined === '' ? line : joined + (opens ? ' ' : '; ') + line
    }
    return joined
  }

  /** Records a command. Returns whether it was kept. */
  async add(uid: number, rawCommand: string): Promise<boolean> {
    const command = this.flatten(rawCommand)
    if (command === undefined) { this.of(uid).position = this.of(uid).entries.length; return false }
    await this.load(uid)
    const user = this.of(uid)

    const raw = this.host.variable('HISTCONTROL')
    const control = new Set((raw === undefined ? 'ignoreboth' : raw).split(/[:,]/).map(s => s.trim()).filter(Boolean))
    if (!this.accepts(user, command, control)) {
      user.position = user.entries.length
      return false
    }

    const fs = this.host.fs()
    if (control.has('erasedups')) {
      const kept = user.entries.filter(entry => entry !== command)
      if (kept.length !== user.entries.length) {
        user.entries = kept
        if (fs) {
          try {
            user.text = kept.length ? kept.join('\n') + '\n' : ''
            await fs.writeFile(this.host.file(uid), user.text, 'utf-8')
            user.fileLines = kept.length
            user.terminated = true
          } catch (error) { this.report(error, 'rewrite') }
        }
      }
    }

    user.entries.push(command)
    const max = this.limit('HISTSIZE', DEFAULT_HISTSIZE)
    while (user.entries.length > max) user.entries.shift()
    user.position = user.entries.length

    if (fs) {
      try {
        // Written from the cached text without reading the file back. `terminated` covers a file an
        // older terminal wrote without a final newline.
        user.text += (user.terminated ? '' : '\n') + command + '\n'
        await fs.writeFile(this.host.file(uid), user.text, 'utf-8')
        user.terminated = true
        user.fileLines++
        // Trim once the file is well past its limit rather than on every command.
        const fileMax = this.limit('HISTFILESIZE', DEFAULT_HISTFILESIZE)
        if (user.fileLines > fileMax * 1.25 + 10) await this.load(uid, true)
      } catch (error) { this.report(error, 'save') }
    }
    return true
  }

  /** Empties history in memory and on disk. */
  async clear(uid: number): Promise<void> {
    const user = this.of(uid)
    user.entries = []
    user.fileLines = 0
    user.position = 0
    user.loaded = true
    user.terminated = true
    user.text = ''
    const fs = this.host.fs()
    if (!fs) return
    try { await fs.writeFile(this.host.file(uid), '', 'utf-8') } catch (error) { this.report(error, 'clear') }
  }
}
