/**
 * Where packages go and what is installed there. root installs for the whole system (`/usr/lib`, `/usr/bin`,
 * `/usr/share`); anyone else into `~/.local`, as `pip --user` does. Each scope keeps a database of its packages: the
 * version, whether it was asked for by name (`explicit`) or came in as another's dependency, and which version of each
 * dependency it was given. `autoremove` removes the dependencies nothing explicit needs any more.
 *
 * A package that is on disk but not in the database (installed before there was one, or linked by the dev server) is
 * adopted when the database is read: its dependencies are matched to the versions installed, and it counts as explicit
 * unless another package depends on it.
 */

import semver from 'semver'

import { join } from '../path-utils.mjs'
import { exists, names, readJson, writeAtomic } from './io.mjs'

const { env, geteuid, readlink } = globalThis.ecmaosSyscalls

/** The scope `options` asks for: `global` is the system's, `user` the caller's own; neither picks by who is asking */
export function scopeOf(options = {}) {
  const root = geteuid() === 0
  const system = options.global || (!options.user && root)
  if (system) {
    return {
      system: true,
      lib: '/usr/lib',
      bin: '/usr/bin',
      share: '/usr/share',
      db: '/var/lib/install/db.json',
      cache: '/var/cache/install'
    }
  }
  const home = env['HOME'] || '/root'
  return {
    system: false,
    lib: join(home, '.local/lib'),
    bin: join(home, '.local/bin'),
    share: join(home, '.local/share'),
    db: join(home, '.local/state/install/db.json'),
    cache: join(home, '.cache/install')
  }
}

/**
 * A project's scope, for `npm install` and the rest: packages go into `DIR/node_modules/.ecmaos/NAME/VERSION`, the ones
 * asked for by name are linked as `DIR/node_modules/NAME`, and their bins as `node_modules/.bin/`. `cache` is the
 * caller's usual one.
 */
export function projectScope(directory, options = {}) {
  const modules = join(directory, 'node_modules')
  return {
    system: false,
    project: true,
    root: directory,
    modules,
    lib: join(modules, '.ecmaos'),
    bin: join(modules, '.bin'),
    share: join(modules, '.ecmaos/.share'),
    db: join(modules, '.ecmaos/db.json'),
    cache: scopeOf(options).cache
  }
}

export const keyOf = (name, version) => `${name}@${version}`

/** The `package.json`s under `lib`: `NAME/VERSION` and `@SCOPE/NAME/VERSION`, where the manifest's version is the directory's */
function onDisk(lib) {
  const found = []
  if (!exists(lib)) return found
  const visit = (name, directory) => {
    for (const version of names(directory)) {
      if (!semver.valid(version)) continue
      const manifest = readJson(join(directory, version, 'package.json'))
      if (manifest?.name === name && manifest.version === version) found.push({ name, version, manifest })
    }
  }
  for (const entry of names(lib)) {
    if (entry.startsWith('.')) continue
    const path = join(lib, entry)
    try {
      if (entry.startsWith('@')) for (const name of names(path)) visit(`${entry}/${name}`, join(path, name))
      else visit(entry, path)
    } catch { /* a file, or unreadable */ }
  }
  return found
}

export class Database {
  constructor(scope) {
    this.scope = scope
    const stored = readJson(scope.db, {})
    this.packages = stored.packages ?? {}
    this.changed = false
    this.adopt()
  }

  adopt() {
    const known = new Set(Object.keys(this.packages))
    const found = onDisk(this.scope.lib).filter(({ name, version }) => !known.has(keyOf(name, version)))
    // a recorded entry whose directory has gone was removed by hand
    for (const key of known) {
      const { name, version } = this.packages[key]
      if (!exists(join(this.scope.lib, name, version, 'package.json'))) { delete this.packages[key]; this.changed = true }
    }
    if (!found.length) return
    const adopted = found.map(({ name, version, manifest }) => ({
      name,
      version,
      explicit: false,
      adopted: true,
      dependencies: {},
      manifest
    }))
    for (const entry of adopted) this.packages[keyOf(entry.name, entry.version)] = entry
    for (const entry of adopted) {
      for (const [dependency, range] of Object.entries(entry.manifest.dependencies ?? {})) {
        const match = this.best(dependency, range)
        if (match) entry.dependencies[dependency] = match.version
      }
    }
    const needed = new Set(adopted.flatMap(entry => Object.entries(entry.dependencies).map(([name, version]) => keyOf(name, version))))
    for (const entry of adopted) {
      entry.explicit = !needed.has(keyOf(entry.name, entry.version))
      entry.linked = entry.explicit && this.linksInto(entry)
      delete entry.manifest
    }
    this.changed = true
  }

  /** Whether one of the package's bins in this scope's `bin` points into its directory */
  linksInto(entry) {
    const manifest = readJson(join(this.scope.lib, entry.name, entry.version, 'package.json'), {})
    const directory = join(this.scope.lib, entry.name, entry.version)
    for (const bin of Object.keys(binsOf(manifest))) {
      try { if (readlink(join(this.scope.bin, bin)).startsWith(directory + '/')) return true } catch { /* not linked */ }
    }
    return false
  }

  save() {
    if (!this.changed) return
    writeAtomic(this.scope.db, JSON.stringify({ format: 1, packages: this.packages }, null, 2) + '\n')
    this.changed = false
  }

  get(name, version) { return this.packages[keyOf(name, version)] }

  set(entry) {
    this.packages[keyOf(entry.name, entry.version)] = entry
    this.changed = true
  }

  delete(name, version) {
    delete this.packages[keyOf(name, version)]
    this.changed = true
  }

  versionsOf(name) {
    return Object.values(this.packages).filter(entry => entry.name === name).sort((a, b) => semver.rcompare(a.version, b.version))
  }

  /** The highest installed version of `name` that `range` takes */
  best(name, range) {
    return this.versionsOf(name).find(entry => satisfies(entry.version, range))
  }

  all() {
    return Object.values(this.packages).sort((a, b) => a.name.localeCompare(b.name) || semver.compare(a.version, b.version))
  }

  explicit() { return this.all().filter(entry => entry.explicit) }

  /** The packages that depend on `name@version` */
  dependentsOf(name, version) {
    return this.all().filter(entry => entry.dependencies?.[name] === version && !(entry.name === name && entry.version === version))
  }

  /** The keys of every package an explicit one needs, itself included */
  required() {
    const seen = new Set()
    const visit = entry => {
      const key = keyOf(entry.name, entry.version)
      if (seen.has(key)) return
      seen.add(key)
      for (const [name, version] of Object.entries(entry.dependencies ?? {})) {
        const dependency = this.get(name, version)
        if (dependency) visit(dependency)
      }
    }
    for (const entry of this.explicit()) visit(entry)
    return seen
  }

  /** The dependencies no explicit package needs */
  orphans() {
    const required = this.required()
    return this.all().filter(entry => !required.has(keyOf(entry.name, entry.version)))
  }
}

/** A package's bins as `{ name: path }`; a single `bin` string is named for the package, without its scope */
export function binsOf(manifest) {
  if (!manifest?.bin) return {}
  if (typeof manifest.bin === 'string') return { [String(manifest.name).split('/').pop()]: manifest.bin }
  return manifest.bin
}

/** `semver.satisfies`, where a missing range, `*`, `latest` and `''` take any version */
export function satisfies(version, range) {
  if (!range || range === '*' || range === 'latest') return true
  return semver.satisfies(version, range, { includePrerelease: false })
}
