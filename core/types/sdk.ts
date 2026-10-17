/**
 * The SDK a display-side app is given: the whole of what it can reach. The app runs in a sandbox in its window's display
 * page (no kernel, no page of the machine, an opaque origin), so everything below is a call over `postMessage` to the
 * display, on to the machine, which acts as the user that started the app, with the same permission checks as a process.
 * An app exports `display(sdk)` (or a default export) from an ES module.
 */

export interface SdkStat {
  size: number
  mode: number
  mtimeMs: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

export interface SdkFs {
  readFile(path: string): Promise<Uint8Array>
  readFile(path: string, encoding: 'utf8' | 'utf-8'): Promise<string>
  /** Large data is sent in pieces, so it is not atomic */
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  appendFile(path: string, data: string | Uint8Array): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<SdkStat>
  access(path: string): Promise<void>
  unlink(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export interface AppSdk {
  readonly command: string
  readonly args: string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly pid: number
  readonly uid: number
  readonly gid: number
  readonly fs: SdkFs
  readonly window: {
    setTitle(title: string): Promise<void>
    /** Closes the window; the app ends with it */
    close(): Promise<void>
  }
  /** Shows a message over the app's window */
  toast(message: string, kind?: 'info' | 'success' | 'error'): void
  /** Writes a line to the machine's log */
  log(message: string): void
  /** Ends the app with an exit code, closing its window */
  exit(code?: number): Promise<void>
  /** Called when the window is going away (closed by the user, or the process killed) */
  onDispose(callback: () => void): void
}

/** What an app module exports */
export type AppMain = (sdk: AppSdk) => Promise<void | number> | void | number
