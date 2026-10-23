/**
 * The kernel's log file. Each write reads and rewrites the whole file (`appendText`), so lines are held for a moment
 * and written together, and a file grown past `maxBytes` is renamed to `<path>.1`, replacing the one before: the log
 * keeps about twice `maxBytes` of history and never costs more than that to write.
 */

import { appendText } from '#lib/append-file.ts'

interface LogFs {
  exists(path: string): Promise<boolean>
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: 'utf-8', mode?: number }): Promise<void>
  stat(path: string): Promise<{ size: number | bigint }>
  rename(from: string, to: string): Promise<void>
}

export class LogFile {
  private _lines: string[] = []
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly _fs: LogFs,
    readonly path: string,
    readonly options: { maxBytes: number, delayMs: number } = { maxBytes: 1 << 20, delayMs: 1000 }
  ) {}

  /** Adds `text` to the file within `delayMs` */
  write(text: string) {
    this._lines.push(text)
    this._timer ??= setTimeout(() => void this.flush(), this.options.delayMs)
  }

  /** Writes what is held now; resolves when it and every earlier write are on the filesystem (or failed) */
  flush(): Promise<void> {
    clearTimeout(this._timer)
    this._timer = undefined
    if (this._lines.length === 0) return this._writing
    const data = this._lines.join('')
    this._lines = []
    // failures are dropped: the log is the one place they cannot go
    this._writing = this._writing.then(() => this._append(data)).catch(() => {})
    return this._writing
  }

  private async _append(data: string) {
    const size = await this._fs.exists(this.path) ? Number((await this._fs.stat(this.path)).size) : 0
    if (size > 0 && size + data.length > this.options.maxBytes) await this._fs.rename(this.path, `${this.path}.1`)
    await appendText(this._fs, this.path, data)
  }
}
