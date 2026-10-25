/**
 * `depmod` and `modprobe`: the module directory `/lib/modules/<release>` with its `modules.dep` and `modules.alias`, the
 * configuration in `/etc/modprobe.d`, and the names `/etc/modules-load.d` asks for at boot. `insmod` loads one file; this loads a
 * module by name with what it depends on, and unloads it with what nothing else holds.
 */

import { modules as loadedModules } from '@zenfs/linux'

import { ModuleError, parseModinfo } from './kmodule.ts'
import type { ModuleManager } from './kmodule.ts'

/** The part of the filesystem this needs; `kernel.filesystem.fs` has it */
export interface ProbeFs {
  readdir(path: string): Promise<string[]>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{ isDirectory(): boolean }>
}

export const moduleDir = (release: string) => `/lib/modules/${release}`

const SUFFIX = '.ko.mjs'
/** Linux treats `-` and `_` in a module name as the same character */
const same = (name: string) => name.replace(/-/g, '_')

const loaded = (name: string) => [...loadedModules.values()].find(mod => same(mod.name) === same(name))

export interface DepmodResult {
  modules: number
  warnings: string[]
}

async function walk(fs: ProbeFs, dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of (await fs.readdir(dir).catch(() => [] as string[])).sort()) {
    const path = `${dir}/${entry}`
    if ((await fs.stat(path)).isDirectory()) found.push(...await walk(fs, path))
    else if (entry.endsWith(SUFFIX)) found.push(path)
  }
  return found
}

/** Reads every `*.ko.mjs` under `dir` and writes `modules.dep` (a module and everything it needs, nearest first) and `modules.alias` */
export async function depmod(fs: ProbeFs, dir: string): Promise<DepmodResult> {
  const warnings: string[] = []
  const found = new Map<string, { path: string, depends: string[], alias: string[] }>()
  for (const path of await walk(fs, dir)) {
    const file = path.split('/').pop()!.slice(0, -SUFFIX.length)
    try {
      const info = parseModinfo(await fs.readFile(path, 'utf8'))
      if (same(info.name) !== same(file)) {
        warnings.push(`${path}: the file is named ${file} but the module says it is ${info.name}; skipped`)
        continue
      }
      found.set(same(file), { path, depends: info.depends, alias: info.alias })
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}; skipped`)
    }
  }

  // depth-first, a module's own needs first, so the order is one a loader can follow
  const order = (name: string, seen: string[] = []): string[] => {
    const entry = found.get(same(name))!
    const out: string[] = []
    for (const dep of entry.depends) {
      if (seen.includes(same(dep))) {
        warnings.push(`${entry.path}: dependency cycle through ${dep}`)
        continue
      }
      const target = found.get(same(dep))
      if (!target) {
        warnings.push(`${entry.path}: needs unknown module ${dep}`)
        continue
      }
      for (const inner of [...order(dep, [...seen, same(name)]), dep]) if (!out.includes(same(inner))) out.push(same(inner))
    }
    return out
  }

  const relative = (path: string) => path.slice(dir.length + 1)
  const dep: string[] = []
  const alias: string[] = []
  for (const [name, entry] of [...found].sort((a, b) => a[0].localeCompare(b[0]))) {
    const needs = order(name).reverse().map(item => relative(found.get(item)!.path))
    dep.push(`${relative(entry.path)}:${needs.length ? ' ' + needs.join(' ') : ''}`)
    for (const pattern of entry.alias) alias.push(`alias ${pattern} ${name}`)
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(`${dir}/modules.dep`, dep.map(line => line + '\n').join(''))
  await fs.writeFile(`${dir}/modules.alias`, alias.sort().map(line => line + '\n').join(''))
  return { modules: found.size, warnings }
}

export interface ProbeConfig {
  options: Map<string, string[]>
  aliases: Array<{ pattern: string, name: string }>
  blacklist: Set<string>
  softdep: Map<string, { pre: string[], post: string[] }>
  install: Map<string, string>
  remove: Map<string, string>
}

/** The `/etc/modprobe.d/*.conf` files, in name order: `options`, `alias`, `blacklist`, `softdep`, `install` and `remove` lines */
export async function readConfig(fs: ProbeFs, dir = '/etc/modprobe.d'): Promise<ProbeConfig> {
  const config: ProbeConfig = { options: new Map(), aliases: [], blacklist: new Set(), softdep: new Map(), install: new Map(), remove: new Map() }
  for (const file of (await fs.readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.conf')).sort()) {
    const text = await fs.readFile(`${dir}/${file}`, 'utf8').catch(() => '')
    for (const raw of text.replace(/\\\n/g, ' ').split('\n')) {
      const line = raw.replace(/#.*/, '').trim()
      if (!line) continue
      const [keyword, name, ...rest] = line.split(/\s+/)
      if (!name) continue
      switch (keyword) {
        case 'options': config.options.set(same(name), [...(config.options.get(same(name)) ?? []), ...rest]); break
        case 'alias': if (rest[0]) config.aliases.push({ pattern: name, name: rest[0] }); break
        case 'blacklist': config.blacklist.add(same(name)); break
        case 'install': config.install.set(same(name), rest.join(' ')); break
        case 'remove': config.remove.set(same(name), rest.join(' ')); break
        case 'softdep': {
          const soft = { pre: [] as string[], post: [] as string[] }
          let into: string[] | undefined
          for (const word of rest) {
            if (word === 'pre:') into = soft.pre
            else if (word === 'post:') into = soft.post
            else into?.push(word)
          }
          config.softdep.set(same(name), soft)
          break
        }
      }
    }
  }
  return config
}

const matches = (pattern: string, name: string) =>
  new RegExp('^' + pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(name)

export interface ProbeOptions {
  /** `-n`: say what would be done and do nothing */
  dryRun?: boolean
  /** `--ignore-install` and `--ignore-remove`: do not run the `install` or `remove` command, load or unload the module itself */
  ignoreCommands?: boolean
  /** `name=value` words from the command line, after those of `modprobe.d` */
  params?: string[]
}

export interface ProbeHost {
  fs: ProbeFs
  kmodules: ModuleManager
  /** `uname -r` */
  release: string
  /** Runs a shell command for `install` and `remove` lines */
  run(command: string): Promise<number>
}

export class ModProbe {
  constructor(private readonly host: ProbeHost) {}

  get dir() { return moduleDir(this.host.release) }

  async #index() {
    if (!await this.host.fs.exists(`${this.dir}/modules.dep`)) await depmod(this.host.fs, this.dir)
    const dep = new Map<string, { path: string, needs: string[] }>()
    for (const line of (await this.host.fs.readFile(`${this.dir}/modules.dep`, 'utf8')).split('\n')) {
      const at = line.indexOf(':')
      if (at < 1) continue
      const path = line.slice(0, at)
      dep.set(same(path.split('/').pop()!.slice(0, -SUFFIX.length)), { path, needs: line.slice(at + 1).trim().split(/\s+/).filter(Boolean) })
    }
    const aliases: Array<{ pattern: string, name: string }> = []
    for (const line of (await this.host.fs.readFile(`${this.dir}/modules.alias`, 'utf8').catch(() => '')).split('\n')) {
      const [keyword, pattern, name] = line.split(/\s+/)
      if (keyword === 'alias' && pattern && name) aliases.push({ pattern, name })
    }
    return { dep, aliases }
  }

  /** The module a request names: its own name, else the first alias that matches */
  #resolve(request: string, index: Awaited<ReturnType<ModProbe['index']>>, config: ProbeConfig) {
    const own = same(request)
    if (index.dep.has(own)) return { name: own, viaAlias: false }
    for (const { pattern, name } of [...config.aliases, ...index.aliases]) {
      if (matches(pattern, request) && index.dep.has(same(name))) return { name: same(name), viaAlias: true }
    }
    throw new ModuleError('ENOENT', `Module ${request} not found in directory ${this.dir}`)
  }

  index() { return this.#index() }

  /** `modprobe NAME`: loads what NAME needs, then NAME; returns the lines a dry run or verbose run prints */
  async load(request: string, options: ProbeOptions = {}, done = new Set<string>()): Promise<string[]> {
    const lines: string[] = []
    const index = await this.#index()
    const config = await readConfig(this.host.fs)
    const { name, viaAlias } = this.#resolve(request, index, config)
    if (done.has(name)) return lines
    done.add(name)
    if (loaded(name)) return lines
    if (viaAlias && config.blacklist.has(name)) return [`modprobe: ${name} is blacklisted; not loaded for the alias ${request}`]

    const command = config.install.get(name)
    if (command !== undefined && !options.ignoreCommands) {
      const text = command.replace(/\$CMDLINE_OPTS/g, (options.params ?? []).join(' '))
      if (options.dryRun) return [text]
      const code = await this.host.run(text)
      if (code !== 0) throw new ModuleError('EIO', `install command for ${name} failed with exit code ${code}`)
      return [text]
    }

    const soft = config.softdep.get(name)
    for (const pre of soft?.pre ?? []) lines.push(...await this.load(pre, { dryRun: options.dryRun }, done).catch(() => []))
    const entry = index.dep.get(name)!
    for (const need of [...entry.needs].reverse()) {
      const file = same(need.split('/').pop()!.slice(0, -SUFFIX.length))
      lines.push(...await this.load(file, { dryRun: options.dryRun }, done))
    }

    const params = [...(config.options.get(name) ?? []), ...(options.params ?? [])]
    lines.push(`insmod ${this.dir}/${entry.path}${params.length ? ' ' + params.join(' ') : ''}`)
    if (!options.dryRun) await this.host.kmodules.load(await this.host.fs.readFile(`${this.dir}/${entry.path}`, 'utf8'), { params })
    for (const post of soft?.post ?? []) lines.push(...await this.load(post, { dryRun: options.dryRun }, done).catch(() => []))
    return lines
  }

  /** `modprobe -r NAME`: unloads NAME, then what it needed that nothing else holds */
  async unload(request: string, options: ProbeOptions = {}): Promise<string[]> {
    const lines: string[] = []
    const index = await this.#index()
    const config = await readConfig(this.host.fs)
    const { name } = this.#resolve(request, index, config)
    const command = config.remove.get(name)
    if (command !== undefined && !options.ignoreCommands) {
      if (!options.dryRun) {
        const code = await this.host.run(command)
        if (code !== 0) throw new ModuleError('EIO', `remove command for ${name} failed with exit code ${code}`)
      }
      return [command]
    }
    const mod = loaded(name)
    if (!mod) throw new ModuleError('ENOENT', `module ${name} is not currently loaded`)
    lines.push(`rmmod ${mod.name}`)
    if (!options.dryRun) await this.host.kmodules.unload(mod.name)
    for (const need of index.dep.get(name)!.needs) {
      const dependency = loaded(need.split('/').pop()!.slice(0, -SUFFIX.length))
      if (!dependency || (!options.dryRun && dependency.refcnt > 0)) continue
      lines.push(`rmmod ${dependency.name}`)
      if (!options.dryRun) await this.host.kmodules.unload(dependency.name).catch(() => {})
    }
    return lines
  }

  /** The names `/etc/modules-load.d/*.conf` asks for, one a line; a failure is reported and does not stop the rest */
  async loadAtBoot(report: (message: string) => void) {
    const dir = '/etc/modules-load.d'
    for (const file of (await this.host.fs.readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.conf')).sort()) {
      for (const raw of (await this.host.fs.readFile(`${dir}/${file}`, 'utf8').catch(() => '')).split('\n')) {
        const name = raw.replace(/[#;].*/, '').trim()
        if (!name) continue
        try {
          await this.load(name)
        } catch (error) {
          report(`modprobe ${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }
}
