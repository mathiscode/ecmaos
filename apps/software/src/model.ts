/**
 * What the Software window does apart from drawing: the commands it runs and how it reads their answers. Everything
 * goes through `software` (the data, as JSON) and `install` (the same engine a terminal uses), so the window has no
 * second implementation of either.
 */

export interface Result { code: number, out: string, err: string }

/** Runs one shell command line and says what it printed */
export type Run = (command: string) => Promise<Result>

export interface Member { name: string, package: string, description: string, kind: string, size?: number, installed: boolean }
export interface Collection { name: string, package: string, description: string, installed: number, total: number, members: Member[] }
export interface Category { name: string, collections: Collection[] }
export interface Row { name: string, package: string, description: string, kind?: string, installed: boolean, source: 'index' | 'npm', version?: string, publisher?: string, date?: string }
export interface InstalledRow { name: string, version: string, explicit: boolean, collection: boolean, system: boolean, description: string, upgradable?: string }
export interface Detail {
  name: string, command?: string, description: string, kind: string, latest?: string, size?: number, license?: string, homepage?: string,
  source?: string, deprecated?: string, dependencies: string[], collections: string[], profiles: string[], everyoneOnly: boolean,
  installed?: { version: string, explicit: boolean, everyone: boolean }, unreachable?: string
}

/** The names `install` takes: an npm package name, with or without a scope. Anything else is not put on a command line */
export const PACKAGE_NAME = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/

/** Quotes a word for the shell */
export const quote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`

export function checked(name: string): string {
  if (!PACKAGE_NAME.test(name)) throw new Error(`${name} is not a package name`)
  return name
}

export type Scope = 'me' | 'everyone'

/**
 * The line that installs `name`. For me is the caller's own `~/.local` (a root user's is the system's, as for `install`);
 * for everyone is `install -g`, behind `sudo -S` with the password read from `passwordFile` when the caller is not root.
 */
export function installCommand(name: string, scope: Scope, root: boolean, passwordFile?: string): string {
  const target = quote(checked(name))
  if (scope === 'me') return root ? `install -g ${target}` : `install ${target}`
  if (root) return `install -g ${target}`
  if (!passwordFile) throw new Error('installing for everyone needs the password')
  return `sudo -S -p '' install -g ${target} < ${quote(passwordFile)}`
}

/** The line that removes `name` from where it is installed */
export function removeCommand(name: string, everyone: boolean, root: boolean, passwordFile?: string): string {
  const target = quote(checked(name))
  if (!everyone) return `install remove ${target}`
  if (root) return `install -g remove ${target}`
  if (!passwordFile) throw new Error('removing for everyone needs the password')
  return `sudo -S -p '' install -g remove ${target} < ${quote(passwordFile)}`
}

/** The first line of `err` that says what went wrong, without colours */
export function reason(result: Result): string {
  const text = (result.err || result.out).replace(/\u001b\[[0-9;]*m/g, '').trim()
  return text.split('\n').filter(Boolean).pop() ?? `exited with ${result.code}`
}

/** Reads the JSON a `software ... --json` printed; throws with the reason when it did not print any */
export function parse<T>(result: Result): T {
  if (result.code !== 0 && !result.out.trim().startsWith('{')) throw new Error(reason(result))
  try { return JSON.parse(result.out) as T } catch { throw new Error(reason(result)) }
}

export class Software {
  constructor(private readonly run: Run) {}

  async explore(): Promise<Category[]> { return parse<{ categories: Category[] }>(await this.run('software list --json')).categories }
  async installed(): Promise<InstalledRow[]> { return parse<{ installed: InstalledRow[] }>(await this.run('software installed --json')).installed }
  async updates(): Promise<{ name: string, installed: string, latest: string }[]> { return parse<{ updates: { name: string, installed: string, latest: string }[] }>(await this.run('software updates --json')).updates }
  async search(text: string, npm: boolean): Promise<{ results: Row[], npm: Row[], unreachable?: string }> {
    const result = await this.run(`software search ${npm ? '--npm ' : ''}--json ${quote(text)}`)
    // an empty answer is exit status 1 with the JSON still printed
    const parsed = parse<{ results: Row[], npm?: Row[], unreachable?: string }>(result)
    return { results: parsed.results, npm: parsed.npm ?? [], unreachable: parsed.unreachable }
  }
  async show(name: string): Promise<Detail> { return parse<Detail>(await this.run(`software show ${quote(checked(name))} --json`)) }
}
