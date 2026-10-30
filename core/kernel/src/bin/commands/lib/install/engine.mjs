/**
 * The package engine `install` and `uninstall` share. Installing is in three steps: the whole tree is resolved first
 * (each package's metadata fetched once, a dependency given a version already installed or planned when its range
 * takes one), then the new tarballs are fetched a few at a time and checked, then each package is unpacked, after its
 * dependencies, and recorded in the scope's database. Only a package asked for by name is linked into `bin` and
 * `share`; its dependencies stay in `lib` for it.
 */

import semver from 'semver'

import { join } from '../path-utils.mjs'
import { SHARE_DIRS, linkTree, unlinkTree } from '../share-links.mjs'
import { unmet, listOf } from './compat.mjs'
import { binsOf, keyOf, satisfies } from './db.mjs'
import { dirname, exists, mkdirp, names, pool, readBytes, readJson, relative, size, untar, writeBytes } from './io.mjs'
import { RegistryError } from './registry.mjs'
import { scriptsAllowed, verifyIntegrity, verifySignature } from './trust.mjs'

const { env, custom, chmod, rename, rmRecursive, rmdir, symlink, unlink, readlink, write } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
export const red = text => `\x1b[31m${text}\x1b[0m`
export const green = text => `\x1b[32m${text}\x1b[0m`
export const blue = text => `\x1b[34m${text}\x1b[0m`
export const yellow = text => `\x1b[33m${text}\x1b[0m`

/** What a command line names: a registry package (`name`, `name@range`, `@scope/name@tag`) or a local tarball */
export function parseSpec(text) {
  const arg = String(text).replace(/^vnpm:/, '')
  if (/^(\/|\.\.?\/|~\/)/.test(arg) || /\.(tgz|tar\.gz)$/.test(arg)) return { type: 'file', path: arg.replace(/^~(?=\/)/, env['HOME'] || '/root') }
  const match = arg.match(/^(@[^/@]+\/[^@/]+|[^@/]+)(?:@(.*))?$/)
  if (!match) return undefined
  return { type: 'registry', name: match[1], range: match[2] || undefined }
}

/** What a dependency's range names, or `undefined` for one `install` cannot fetch (git, a path, a URL, a workspace) */
function dependencySpec(name, range) {
  const value = String(range ?? '').trim()
  if (value.startsWith('npm:')) {
    const real = parseSpec(value.slice(4))
    return real?.type === 'registry' ? { name: real.name, range: real.range, alias: name } : undefined
  }
  if (/^(file:|link:|workspace:|git(\+[a-z]+)?:|https?:|github:|gitlab:|bitbucket:)/.test(value)) return undefined
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(value)) return undefined
  return { name, range: value || undefined }
}

/** The version of `document` that `range` names: a dist-tag, an exact version, or the highest a range takes */
export function pickVersion(document, range) {
  const tags = document['dist-tags'] ?? {}
  if (!range || range === 'latest') return tags.latest
  if (tags[range]) return tags[range]
  if (document.versions?.[range]) return range
  const candidates = Object.keys(document.versions ?? {})
  // the latest tag wins when the range takes it, as npm prefers it
  if (tags.latest && semver.satisfies(tags.latest, range)) return tags.latest
  try { return semver.maxSatisfying(candidates, range) ?? undefined } catch { return undefined }
}

/** Whether a manifest's `os` or `cpu` rules ecmaOS out (a native build, such as esbuild's per-platform packages) */
function wrongPlatform(manifest) {
  const rules = [manifest?.os, manifest?.cpu].filter(Array.isArray)
  return rules.some(list => list.length && !list.some(item => /^(ecmaos|browser|wasm32|any)$/.test(item)))
}

const safe = name => name.replace(/[^a-zA-Z0-9._-]/g, '_')

export class Engine {
  constructor({ scope, db, registry, options = {} }) {
    this.scope = scope
    this.db = db
    this.registry = registry
    this.options = options
    /** Packages the plan's packages suggest; printed after the summary, never installed */
    this.suggested = new Set()
  }

  /** Informational output; `options.quiet` is for a front-end that tells the story in its own words (errors still print) */
  out(text) { if (!this.options.quiet) write(1, encoder.encode(text + '\n')) }
  err(text) { write(2, encoder.encode(text + '\n')) }

  // Resolving

  /** The tree `requests` need, as plan nodes keyed `name@version`. Throws a `RegistryError` for what cannot be had */
  async resolve(requests) {
    const plan = new Map()
    const plannedOf = name => [...plan.values()].filter(node => node.name === name).sort((a, b) => semver.rcompare(a.version, b.version))
    let level = requests.map(request => ({ ...request, explicit: true }))
    while (level.length) {
      const next = []
      // the metadata a level needs, fetched together
      const fetching = level.filter(request => !request.local && !this.settled(request, plannedOf))
      await Promise.all(fetching.map(request => this.registry.metadata(request.name).catch(() => undefined)))
      for (const request of level) {
        let node
        try {
          node = await this.pick(request, plan, plannedOf)
        } catch (error) {
          if (request.optional) { this.err(yellow(`Skipping optional dependency ${request.name}: ${error.message}`)); continue }
          throw error
        }
        if (!node) continue
        if (request.parent) {
          request.parent.dependencies[node.name] = node.version
          if (request.alias && request.alias !== node.name) request.parent.aliases[request.alias] = node.name
        }
        const key = keyOf(node.name, node.version)
        if (plan.has(key)) {
          if (request.explicit) plan.get(key).explicit = true
          continue
        }
        if (!node.existing) this.check(node, plan)
        plan.set(key, node)
        if (node.existing) continue
        const manifest = node.manifest
        const optional = manifest.optionalDependencies ?? {}
        const wanted = { ...manifest.dependencies, ...optional }
        for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
          if (name in wanted || manifest.peerDependenciesMeta?.[name]?.optional) continue
          wanted[name] = range
        }
        for (const [name, range] of Object.entries(wanted)) {
          const spec = dependencySpec(name, range)
          if (!spec) { this.err(yellow(`${node.name}@${node.version}: cannot fetch the dependency ${name}@${range}; skipped`)); continue }
          next.push({ ...spec, parent: node, optional: name in optional })
        }
        // recommended packages come along unless asked not to; one that cannot be had is skipped, not an error
        if (!this.options.noRecommends) {
          for (const text of listOf(manifest, 'recommends')) {
            const spec = parseSpec(text)
            if (spec?.type === 'registry' && !(spec.name in wanted)) next.push({ name: spec.name, range: spec.range, parent: node, optional: true })
          }
        }
        for (const text of listOf(manifest, 'suggests')) this.suggested.add(text)
      }
      level = next
    }
    return plan
  }

  /**
   * Refuses a package this kernel cannot run (`ecmaos.requires`, unless `--force`) or one that conflicts with an
   * installed or planned package (`ecmaos.conflicts`, from either side). Throws a `RegistryError`.
   */
  check(node, plan) {
    const problems = this.options.force ? [] : unmet(node.manifest)
    if (problems.length) throw new RegistryError(`${node.name}@${node.version} ${problems.join(' and ')}`)
    const present = [...this.db.all().map(entry => ({ name: entry.name, conflicts: listOf(readJson(join(this.scope.lib, entry.name, entry.version, 'package.json'), {}), 'conflicts') })),
      ...[...plan.values()].filter(other => !other.existing).map(other => ({ name: other.name, conflicts: listOf(other.manifest, 'conflicts') }))]
    const mine = listOf(node.manifest, 'conflicts').map(text => parseSpec(text)?.name ?? text)
    for (const other of present) {
      if (other.name === node.name) continue
      if (mine.includes(other.name) || other.conflicts.some(text => (parseSpec(text)?.name ?? text) === node.name)) {
        throw new RegistryError(`${node.name} conflicts with ${other.name}, which is ${this.db.all().some(entry => entry.name === other.name) ? 'installed' : 'in this install'}`)
      }
    }
  }

  /** Whether a dependency is met by a version installed or already planned, so its metadata is not needed */
  settled(request, plannedOf) {
    if (request.explicit) return false
    return plannedOf(request.name).some(node => satisfies(node.version, request.range)) || Boolean(this.db.best(request.name, request.range))
  }

  async pick(request, plan, plannedOf) {
    if (request.local) return request.local
    if (!request.explicit) {
      const planned = plannedOf(request.name).find(node => satisfies(node.version, request.range))
      if (planned) return planned
      const installed = this.db.best(request.name, request.range)
      if (installed) return { name: installed.name, version: installed.version, existing: true, explicit: false, dependencies: installed.dependencies ?? {} }
    }
    const document = await this.registry.metadata(request.name)
    const version = pickVersion(document, request.range)
    const manifest = version && document.versions?.[version]
    if (!manifest) throw new RegistryError(`No version of ${request.name} matches ${request.range ?? 'latest'}`)
    if (request.optional && wrongPlatform(manifest)) return undefined
    if (manifest.deprecated && request.explicit) this.err(yellow(`${request.name}@${version} is deprecated: ${manifest.deprecated}`))
    const installed = this.db.get(request.name, version)
    if (installed && !(request.explicit && this.options.reinstall)) {
      return { name: request.name, version, existing: true, explicit: Boolean(request.explicit), dependencies: installed.dependencies ?? {} }
    }
    return { name: request.name, version, manifest, dist: manifest.dist, explicit: Boolean(request.explicit), dependencies: {}, aliases: {}, reinstall: Boolean(installed) }
  }

  /** A local tarball as a plan node: unpacked now, since its manifest is inside it */
  async local(path) {
    const scratch = join(this.scope.lib, `.install-local-${Date.now()}`)
    mkdirp(scratch)
    if (await this.tar(path, scratch) !== 0) { rmRecursive(scratch); throw new RegistryError(`${path}: not a tarball tar can unpack`) }
    const root = exists(join(scratch, 'package')) ? join(scratch, 'package') : scratch
    const manifest = readJson(join(root, 'package.json'))
    if (!manifest?.name || !semver.valid(manifest.version)) { rmRecursive(scratch); throw new RegistryError(`${path}: has no package.json with a name and a version`) }
    return { name: manifest.name, version: manifest.version, manifest, explicit: true, dependencies: {}, aliases: {}, unpacked: { scratch, root }, source: `file:${path}`, reinstall: Boolean(this.db.get(manifest.name, manifest.version)) }
  }

  // Installing

  /** Installs `requests` (`{ name, range }`, or `{ local: node }`); returns an exit code */
  async install(requests) {
    let plan
    try {
      plan = await this.resolve(requests)
    } catch (error) {
      this.discard(requests)
      this.err(red(`install: ${error instanceof Error ? error.message : String(error)}`))
      return 1
    }
    this.summary([...plan.values()])
    if (this.options.dryRun) return 0
    return await this.apply(plan)
  }

  /** Removes the scratch directories of local tarballs that were unpacked for requests that will not be carried out */
  discard(requests) {
    for (const request of requests) if (request.local?.unpacked) try { rmRecursive(request.local.unpacked.scratch) } catch { /* gone */ }
  }

  /**
   * What a plan does, by kind: `added` (new), `upgraded`, `reinstalled` and `already` (asked for by name, nothing to do),
   * each a list of plan nodes; `fresh` is every node that will be unpacked.
   */
  changes(plan) {
    const nodes = [...plan.values()]
    const fresh = nodes.filter(node => !node.existing)
    const upgraded = fresh.filter(node => !node.reinstall && this.db.versionsOf(node.name).length)
    return {
      nodes,
      fresh,
      upgraded,
      added: fresh.filter(node => !node.reinstall && !upgraded.includes(node)),
      reinstalled: fresh.filter(node => node.reinstall),
      already: nodes.filter(node => node.existing && node.explicit)
    }
  }

  /** Carries out a resolved plan: fetches, checks and unpacks what is new; returns an exit code */
  async apply(plan) {
    const nodes = [...plan.values()]
    const fresh = nodes.filter(node => !node.existing)

    for (const node of nodes.filter(node => node.existing && node.explicit)) await this.adoptExplicit(node)

    const fromRegistry = fresh.filter(node => !node.unpacked)
    if (fromRegistry.length) {
      const total = fromRegistry.reduce((sum, node) => sum + (node.dist?.unpackedSize ?? 0), 0)
      this.out(`Fetching ${fromRegistry.length} package${fromRegistry.length === 1 ? '' : 's'}${total ? ` (${size(total)} unpacked)` : ''} from ${this.registry.url}...`)
    }
    const fetched = await pool(fromRegistry, 4, async node => {
      try {
        if (!this.options.ignoreSignatures) {
          const problem = await verifySignature(this.registry.url, node.name, node.version, node.dist)
          if (problem) throw new RegistryError(problem)
        }
        node.tarball = await this.registry.tarball(node.name, node.version, node.dist, bytes => verifyIntegrity(bytes, node.dist))
        return undefined
      } catch (error) {
        return `${node.name}@${node.version}: ${error instanceof Error ? error.message : String(error)}`
      }
    })
    const failures = fetched.filter(Boolean)
    if (failures.length) {
      for (const failure of failures) this.err(red(failure))
      for (const node of fresh) if (node.unpacked) try { rmRecursive(node.unpacked.scratch) } catch { /* gone */ }
      return 1
    }

    let code = 0
    for (const node of this.order(fresh, plan)) {
      if (!await this.place(node)) { code = 1; break }
      this.options.placed?.(node)
    }
    if (!code) { this.retireSuperseded(nodes); this.retireReplaced(nodes) }
    this.db.save()
    if (!code) this.orphanHint()
    return code
  }

  /** Dependencies before their dependents, so a postinstall finds what it needs */
  order(nodes, plan) {
    const ordered = []
    const seen = new Set()
    const visit = node => {
      const key = keyOf(node.name, node.version)
      if (seen.has(key)) return
      seen.add(key)
      for (const [name, version] of Object.entries(node.dependencies)) {
        const dependency = plan.get(keyOf(name, version))
        if (dependency && !dependency.existing) visit(dependency)
      }
      ordered.push(node)
    }
    for (const node of nodes) visit(node)
    return ordered
  }

  summary(nodes) {
    const { fresh, upgraded, added, reinstalled: again, already } = this.changes(new Map(nodes.map(node => [keyOf(node.name, node.version), node])))
    for (const node of already) this.out(green(`${node.name} v${node.version} is already installed`))
    if (!fresh.length) return
    const list = items => '  ' + items.map(node => `${node.name}@${node.version}${node.explicit ? '' : ' (dependency)'}`).join('\n  ')
    if (added.length) this.out(`The following NEW packages will be installed:\n${list(added)}`)
    if (upgraded.length) this.out(`The following packages will be upgraded:\n  ${upgraded.map(node => `${node.name} (${this.db.versionsOf(node.name)[0].version} => ${node.version})`).join('\n  ')}`)
    if (again.length) this.out(`The following packages will be reinstalled:\n${list(again)}`)
    this.out(`${upgraded.length} upgraded, ${added.length} newly installed, ${again.length} reinstalled.`)
    if (this.suggested.size) this.out(`Suggested packages:\n  ${[...this.suggested].join('\n  ')}`)
  }

  /** A package asked for by name that is already installed: it becomes explicit, and its links are made again */
  async adoptExplicit(node) {
    const entry = this.db.get(node.name, node.version)
    if (!entry) return
    entry.explicit = true
    this.db.set(entry)
    const manifest = readJson(join(this.scope.lib, node.name, node.version, 'package.json'), {})
    if (this.link(entry, manifest)) this.unmarkOthers(entry)
  }

  tar(path, directory) { return untar(path, directory) }

  /** Unpacks a node into `lib/NAME/VERSION`, records it, runs its scripts and links it; false when it failed */
  async place(node) {
    const { name, version } = node
    const target = join(this.scope.lib, name, version)
    let root
    let scratch
    if (node.unpacked) {
      ({ root, scratch } = node.unpacked)
    } else {
      // npm tarballs wrap their contents in `package/`, so extraction lands in a scratch directory on the same mount as
      // the install path (`rename` across mounts fails with `EXDEV`) and its contents become the install path
      scratch = join(this.scope.lib, `.install-${safe(name)}-${version}-${Date.now()}`)
      mkdirp(scratch)
      if (await this.tar(node.tarball.path, scratch) !== 0) {
        this.err(red(`Failed to extract ${name}@${version}`))
        rmRecursive(scratch)
        return false
      }
      root = exists(join(scratch, 'package')) ? join(scratch, 'package') : scratch
    }
    if (exists(target)) {
      const old = this.db.get(name, version)
      if (old) this.unlinkEntry(old)
      rmRecursive(target)
    }
    mkdirp(dirname(target))
    rename(root, target)
    try { rmRecursive(scratch) } catch { /* moved whole */ }
    this.out(green(`Installed ${name} v${version} to ${target}`))

    const manifest = readJson(join(target, 'package.json'), {})
    this.linkDependencies(node, target)
    const entry = {
      name,
      version,
      explicit: node.explicit,
      dependencies: node.dependencies,
      ...(Object.keys(node.aliases ?? {}).length ? { aliases: node.aliases } : {}),
      source: node.source ?? this.registry.url,
      ...(node.dist?.integrity ? { integrity: node.dist.integrity } : {}),
      installed: new Date().toISOString(),
      linked: false
    }
    this.db.set(entry)
    this.db.save()

    if (!await this.script(node, manifest, 'ecmaos:preinstall', target)) return false
    if (node.explicit) {
      if (!this.link(entry, manifest)) return false
      this.unmarkOthers(entry)
    }
    if (!await this.installModules(entry, manifest)) return false
    if (!await this.script(node, manifest, 'ecmaos:postinstall', target)) return false
    return true
  }

  /**
   * Lays out `node_modules` as Node finds it: a link from `target/node_modules/NAME` to each dependency's directory in
   * `lib` (what `npm:` aliased it as, if it was). A program that imports `NAME` finds the very version this package was
   * given, and the same directory serves every package that depends on it.
   */
  linkDependencies(node, target) {
    const aliasOf = new Map(Object.entries(node.aliases ?? {}).map(([alias, name]) => [name, alias]))
    for (const [name, version] of Object.entries(node.dependencies ?? {})) {
      const link = join(target, 'node_modules', aliasOf.get(name) ?? name)
      const destination = join(this.scope.lib, name, version)
      try {
        mkdirp(dirname(link))
        try { unlink(link) } catch { /* nothing there yet */ }
        symlink(relative(dirname(link), destination), link)
      } catch (error) {
        this.err(yellow(`Could not link ${link}: ${error instanceof Error ? error.message : error}`))
      }
    }
  }

  /** Runs one of the package's `ecmaos:` scripts with `sh -c`, as whoever runs `install`, if its scripts may run */
  async script(node, manifest, name, directory) {
    const command = manifest.scripts?.[name]
    if (!command) return true
    if (!this.options.allowScripts && !scriptsAllowed(node.name)) {
      this.err(yellow(`Skipped ${name} of ${node.name}@${node.version}: its scripts are not trusted (--allow-scripts runs them)`))
      return true
    }
    try {
      const environment = { ...env, npm_package_name: node.name, npm_package_version: node.version, INSTALL_PREFIX: dirname(this.scope.lib) }
      const pid = await custom('proc_spawn', '/bin/sh', JSON.stringify(['sh', '-c', command]), directory, JSON.stringify({ env: environment }))
      const code = await custom('proc_wait', pid)
      if (code) throw new Error(`exited with ${code}`)
      return true
    } catch (error) {
      this.err(red(`Failed to execute ${name.replace('ecmaos:', '')} script for ${node.name}@${node.version}: ${error instanceof Error ? error.message : error}`))
      return false
    }
  }

  /** Links a package's bins into `bin` and its `share/` files into `share`; an upgrade replaces the links an earlier version left */
  link(entry, manifest) {
    const directory = join(this.scope.lib, entry.name, entry.version)
    try {
      const bins = binsOf(manifest)
      if (Object.keys(bins).length) mkdirp(this.scope.bin)
      for (const [bin, file] of Object.entries(bins)) {
        const binPath = join(directory, file)
        if (!exists(binPath)) {
          this.err(red(`${binPath} does not exist`))
          return false
        }
        // a tarball keeps the mode of the file it was packed from, and npm makes a bin executable as it installs it
        chmod(binPath, 0o755)
        try { unlink(join(this.scope.bin, bin)) } catch { /* not linked yet */ }
        symlink(binPath, join(this.scope.bin, bin))
        this.out(blue(`Linked ${bin} to ${join(this.scope.bin, bin)}`))
      }
    } catch (error) {
      this.err(red(`Failed to link bins for ${entry.name}@${entry.version}: ${error}`))
    }
    this.linkProject(entry)
    // `share/applications`, `docs`, `licenses` and `man` are linked where the desktop's launcher, `man` and the rest look
    for (const share of this.scope.project ? [] : SHARE_DIRS) {
      try {
        const source = join(directory, 'share', share)
        if (exists(source)) for (const linked of linkTree(source, join(this.scope.share, share))) this.out(blue(`Linked ${linked}`))
      } catch (error) {
        this.err(red(`Failed to link share/${share} for ${entry.name}@${entry.version}: ${error}`))
      }
    }
    this.linkRuntime(entry, manifest, directory)
    // a copyleft program's source is a package of its own (`NAME-src`, the same version)
    const source = manifest.ecmaos?.source
    if (typeof source === 'string') this.out(blue(`Corresponding source: install ${source.replace(/@[^@/]+$/, '')}`))
    entry.linked = true
    this.db.set(entry)
    return true
  }

  /**
   * A program that needs files beside it (`vim`'s /usr/share/vim, `python3`'s standard library) ships them in the
   * package's `"ecmaos": { "runtime": "runtime" }` directory, laid out from `/`. Its `usr/` is linked into `/usr` file by
   * file, so removing the package takes it away again; only a system install has a `/usr` to put it in.
   */
  linkRuntime(entry, manifest, directory) {
    const runtime = runtimeOf(manifest)
    if (!runtime) return
    const source = join(directory, runtime, 'usr')
    if (!exists(source)) return
    if (!this.scope.system) {
      this.err(yellow(`${entry.name}@${entry.version} needs files under /usr, which only a system install puts in place (sudo install -g ${entry.name})`))
      return
    }
    try {
      const linked = linkTree(source, '/usr')
      this.out(blue(`Linked ${linked.length} runtime files into /usr`))
    } catch (error) {
      this.err(red(`Failed to link the runtime of ${entry.name}@${entry.version}: ${error}`))
    }
  }

  /** In a project, a package asked for by name is the project's own dependency: `node_modules/NAME` points at it */
  linkProject(entry) {
    if (!this.scope.project) return
    const link = join(this.scope.modules, entry.name)
    try {
      mkdirp(dirname(link))
      try { unlink(link) } catch { /* nothing there yet */ }
      symlink(relative(dirname(link), join(this.scope.lib, entry.name, entry.version)), link)
    } catch (error) {
      this.err(yellow(`Could not link ${link}: ${error instanceof Error ? error.message : error}`))
    }
  }

  /** The other versions of a package that was just linked: no longer what the name means */
  unmarkOthers(entry) {
    for (const other of this.db.versionsOf(entry.name)) {
      if (other.version === entry.version || (!other.explicit && !other.linked)) continue
      other.explicit = false
      other.linked = false
      this.db.set(other)
    }
  }

  /** Removes the links that point into a package's directory, leaving any another version or package made */
  unlinkEntry(entry) {
    const directory = join(this.scope.lib, entry.name, entry.version)
    const manifest = readJson(join(directory, 'package.json'), {})
    for (const bin of Object.keys(binsOf(manifest))) {
      const path = join(this.scope.bin, bin)
      try {
        if (!readlink(path).startsWith(directory + '/')) continue
        unlink(path)
        this.out(`Unlinked ${bin} from ${path}`)
      } catch { /* not linked */ }
    }
    for (const share of SHARE_DIRS) {
      try {
        const source = join(directory, 'share', share)
        if (exists(source)) unlinkTree(source, join(this.scope.share, share))
      } catch { /* nothing to unlink */ }
    }
    const runtime = runtimeOf(manifest)
    if (runtime && this.scope.system) {
      try { unlinkTree(join(directory, runtime, 'usr'), '/usr') } catch { /* nothing to unlink */ }
    }
    if (this.scope.project) {
      const link = join(this.scope.modules, entry.name)
      try { if (readlink(link).endsWith(`${entry.name}/${entry.version}`)) unlink(link) } catch { /* not linked */ }
    }
    entry.linked = false
  }

  /**
   * A package that ships kernel modules lists them in `package.json` as `"ecmaos": { "modules": ["dist/NAME.ko.mjs"] }`
   * (paths inside the package; `.ko.mjs` or `.ko.wasm`). They are copied into `/lib/modules/RELEASE/` and `depmod`
   * indexes them, so `modprobe NAME` finds them. Only a system install has a place for them.
   */
  async installModules(entry, manifest) {
    const files = modulesOf(manifest)
    if (!files.length) return true
    if (!this.scope.system) {
      this.err(yellow(`${entry.name}@${entry.version} ships kernel modules, which only a system install puts in place (sudo install -g ${entry.name})`))
      return true
    }
    try {
      const directory = join('/lib/modules', env['KERNEL_VERSION'])
      for (const file of files) {
        const name = file.slice(file.lastIndexOf('/') + 1)
        const source = join(this.scope.lib, entry.name, entry.version, file)
        if (!/^[\w.+-]+\.ko\.(mjs|wasm)$/.test(name)) throw new Error(`${file} is not a NAME.ko.mjs or NAME.ko.wasm file`)
        if (!exists(source)) throw new Error(`${source} does not exist`)
        mkdirp(directory)
        writeBytes(join(directory, name), readBytes(source))
        this.out(blue(`Installed module ${name} in ${directory}`))
      }
      const code = await custom('shell_exec', 'depmod')
      if (code) throw new Error(`depmod failed (${code}); run it as root`)
      return true
    } catch (error) {
      this.err(red(`Failed to install the modules of ${entry.name}@${entry.version}: ${error instanceof Error ? error.message : error}`))
      return false
    }
  }

  /** An old version an upgrade replaced goes, unless something still depends on it */
  retireSuperseded(nodes) {
    const required = this.db.required()
    for (const node of nodes.filter(node => node.explicit && !node.existing)) {
      for (const old of this.db.versionsOf(node.name)) {
        if (old.version === node.version || old.explicit || required.has(keyOf(old.name, old.version))) continue
        this.removeEntry(old)
      }
    }
  }

  /** A package that `ecmaos.replaces` an installed one (a rename) takes its place: the old name goes, with a note */
  retireReplaced(nodes) {
    for (const node of nodes.filter(node => !node.existing && node.manifest)) {
      for (const text of listOf(node.manifest, 'replaces')) {
        const old = parseSpec(text)?.name
        if (!old || old === node.name) continue
        for (const entry of this.db.versionsOf(old)) {
          this.out(yellow(`${old} is replaced by ${node.name}`))
          this.removeEntry(entry)
        }
      }
    }
  }

  orphanHint() {
    const orphans = this.db.orphans()
    if (!orphans.length) return
    this.out(`The following packages were installed as dependencies and are no longer required:\n  ${orphans.map(entry => keyOf(entry.name, entry.version)).join('\n  ')}\nUse 'install autoremove' to remove them.`)
  }

  // Removing

  /** Deletes a package's files, links and modules, and its record; true when it is gone */
  removeEntry(entry) {
    const directory = join(this.scope.lib, entry.name, entry.version)
    this.unlinkEntry(entry)
    let modules = false
    if (this.scope.system) {
      for (const file of modulesOf(readJson(join(directory, 'package.json'), {}))) {
        const target = join('/lib/modules', env['KERNEL_VERSION'], file.slice(file.lastIndexOf('/') + 1))
        try { unlink(target); modules = true; this.out(`Removed module ${target}`) } catch { /* not installed there */ }
      }
    }
    try {
      rmRecursive(directory)
    } catch (error) {
      this.err(red(`Failed to remove ${directory}: ${error instanceof Error ? error.message : String(error)}`))
      return false
    }
    this.pruneEmpty(dirname(directory))
    this.db.delete(entry.name, entry.version)
    this.out(`Uninstalled ${entry.name}@${entry.version}`)
    if (modules) this.depmod = true
    return true
  }

  /** Removes `NAME/` (and `@scope/`) once no version is left in it */
  pruneEmpty(directory) {
    for (let path = directory; path.startsWith(this.scope.lib + '/') && path !== this.scope.lib; path = dirname(path)) {
      try { if (names(path).length) return; rmdir(path) } catch { return }
    }
  }

  /**
   * Removes `specs` (`name` or `name@version`). A package another still depends on keeps its files and becomes a
   * dependency: its links go, and `autoremove` takes it once nothing needs it. Returns an exit code.
   */
  async remove(specs, { autoremove = false } = {}) {
    let failed = false
    const targets = []
    for (const text of specs) {
      const spec = parseSpec(text)
      if (spec?.type !== 'registry') { this.err(red(`Invalid package name format: ${text}`)); failed = true; continue }
      const entries = spec.range ? [this.db.get(spec.name, spec.range)].filter(Boolean) : this.db.versionsOf(spec.name)
      if (entries.length) { targets.push(...entries); continue }
      // a directory without a package.json the database could adopt
      const leftover = join(this.scope.lib, spec.name, spec.range ?? '')
      if (exists(leftover)) {
        rmRecursive(leftover)
        this.pruneEmpty(dirname(leftover))
        this.out(`Uninstalled ${spec.range ? `${spec.name}@${spec.range}` : spec.name}`)
        continue
      }
      if (spec.range && this.db.versionsOf(spec.name).length) {
        this.err(red(`Version ${spec.range} of ${spec.name} is not installed`))
        this.err(`Installed versions: ${this.db.versionsOf(spec.name).map(entry => entry.version).join(', ')}`)
      } else {
        this.err(red(`Package ${spec.name} is not installed${this.scope.system ? '' : ` in ${this.scope.lib}`}`))
      }
      failed = true
    }
    const removing = new Set(targets.map(entry => keyOf(entry.name, entry.version)))
    for (const entry of targets) {
      const keepers = this.db.dependentsOf(entry.name, entry.version).filter(other => !removing.has(keyOf(other.name, other.version)))
      if (keepers.length) {
        this.unlinkEntry(entry)
        entry.explicit = false
        this.db.set(entry)
        this.out(`${entry.name}@${entry.version} is still needed by ${keepers.map(other => keyOf(other.name, other.version)).join(', ')}; kept as a dependency`)
        continue
      }
      if (!this.removeEntry(entry)) failed = true
    }
    if (autoremove) failed = !this.autoremove(true) || failed
    else this.orphanHint()
    if (this.depmod) await custom('shell_exec', 'depmod')
    this.db.save()
    return failed ? 1 : 0
  }

  /** Removes the dependencies nothing explicit needs, again and again until none is left; false if one could not go */
  autoremove(quiet = false) {
    let ok = true
    let removed = 0
    for (let orphans = this.db.orphans(); orphans.length; orphans = this.db.orphans()) {
      if (this.options.dryRun) {
        this.out(`Would remove:\n  ${orphans.map(entry => keyOf(entry.name, entry.version)).join('\n  ')}`)
        return true
      }
      let progress = false
      for (const entry of orphans) if (this.removeEntry(entry)) { progress = true; removed++ } else ok = false
      if (!progress) break
    }
    if (!removed && !quiet) this.out('0 packages to remove.')
    return ok
  }
}

/** The directory of a package's runtime files (`"ecmaos": { "runtime": "runtime" }`), or `undefined` */
export function runtimeOf(manifest) {
  const runtime = manifest?.ecmaos?.runtime
  return typeof runtime === 'string' && runtime && !runtime.startsWith('/') && !runtime.split('/').includes('..') ? runtime : undefined
}

export function modulesOf(manifest) {
  const listed = manifest?.ecmaos?.modules ?? manifest?.ecmaos?.module ?? []
  return (Array.isArray(listed) ? listed : [listed]).filter(file => typeof file === 'string')
}

