/**
 * `apt`, `apt-get` and `apt-cache` over `install`'s engine. The names a user types are Debian's; the index
 * (`@ecmaos/package-index`) maps them to npm packages, and everything else is the engine's: the same database, cache and
 * signature checks. Output is shaped like apt's. As root, packages go to the whole system; as anyone else, to `~/.local`.
 */

import { join } from '../path-utils.mjs'
import { pickVersion } from './engine.mjs'
import { exists, mkdirp, untar } from './io.mjs'
import { entries, nameFor, refreshIndex } from './names.mjs'
import { verifyIntegrity, verifySignature } from './trust.mjs'
import { cachedUpgradable, latestOf, newer } from './updates.mjs'
import {
  Failure, confirm, dependsOf, directoryOf, displayName, err, installed, isRoot, kilobytes, manifestOf, openSession, out, sizeOf,
  suggest, tilde, translate, wrap
} from './frontend.mjs'

const { getcwd, rename, rmRecursive, getpid } = globalThis.ecmaosSyscalls

const VERBS = {
  apt: ['update', 'upgrade', 'full-upgrade', 'install', 'reinstall', 'remove', 'purge', 'autoremove', 'autopurge', 'search', 'show', 'list', 'policy', 'depends', 'rdepends', 'clean', 'autoclean', 'source'],
  'apt-get': ['update', 'upgrade', 'dist-upgrade', 'install', 'reinstall', 'remove', 'purge', 'autoremove', 'autopurge', 'clean', 'autoclean', 'check', 'source'],
  'apt-cache': ['search', 'show', 'policy', 'depends', 'rdepends', 'pkgnames']
}

const usage = command => `Usage: ${command} [options] command

${command === 'apt-cache' ? 'apt-cache queries the package index and what is installed.' : `${command} installs, removes and upgrades packages: Debian's package names, npm's packages underneath (see install(1)).`}

Commands:
${VERBS[command].map(verb => `  ${verb}`).join('\n')}

Options:
  -y, --yes            assume yes to the questions
  -s, --simulate       do nothing; show what would be done
  -q, --quiet          less output (-qq: errors only)
      --reinstall      install a package again
      --registry=URL   npm registry to use (default: $REGISTRY, else https://registry.npmjs.org)
      --user           install for yourself (~/.local), even as root
      --offline        use only the cache
      --installed      with list, only installed packages
      --upgradable     with list, only packages that can be upgraded`

const FLAGS = {
  '-y': 'yes', '--yes': 'yes', '--assume-yes': 'yes', '--force-yes': 'yes',
  '-s': 'simulate', '--simulate': 'simulate', '--just-print': 'simulate', '--dry-run': 'simulate', '--recon': 'simulate', '--no-act': 'simulate',
  '--reinstall': 'reinstall', '--purge': 'purge', '--auto-remove': 'autoremove', '--autoremove': 'autoremove',
  '--installed': 'installed', '--upgradable': 'upgradable', '-a': 'all', '--all-versions': 'all', '--user': 'user', '--offline': 'offline',
  '--no-install-recommends': 'noRecommends', '--force': 'force', '--allow-unsigned': 'allowUnsigned', '--allow-unauthenticated': 'allowUnsigned', '--ignore-signatures': 'ignoreSignatures', '--allow-scripts': 'allowScripts'
}
// accepted, and nothing to do on ecmaOS
const IGNORED = new Set(['-f', '--fix-broken', '--fix-missing', '-m', '--ignore-missing', '--install-recommends', '--no-install-suggests', '--install-suggests', '-V', '--verbose-versions', '--allow-downgrades', '--allow-change-held-packages', '-d', '--download-only', '--no-upgrade', '--only-upgrade', '--show-progress', '--allow-remove-essential', '--no-remove', '-u', '--show-upgraded', '--no-download', '--trivial-only'])
const WITH_VALUE = new Set(['-o', '--option', '-t', '--target-release', '--default-release', '-c', '--config-file', '-a', '--host-architecture', '-p', '--print-uris'])

function parse(command, args) {
  const o = { quiet: 0, targets: [] }
  let verb
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { o.targets.push(...args.slice(i + 1)); break }
    if (arg === '-h' || arg === '--help') { o.help = true; continue }
    if (arg === '-v' || arg === '--version') { o.version = true; continue }
    if (arg === '--registry') { o.registry = args[++i]; continue }
    if (arg.startsWith('--registry=')) { o.registry = arg.slice(11); continue }
    if (arg === '-q' || arg === '--quiet') { o.quiet++; continue }
    if (arg.startsWith('--quiet=')) { o.quiet = Number(arg.slice(8)) || 1; continue }
    if (/^-q+$/.test(arg)) { o.quiet += arg.length - 1; continue }
    if (FLAGS[arg]) { o[FLAGS[arg]] = true; continue }
    if (IGNORED.has(arg)) continue
    if (WITH_VALUE.has(arg)) { i++; continue }
    if (/^-[ysqf]{2,}$/.test(arg)) {
      for (const letter of arg.slice(1)) { if (letter === 'q') o.quiet++; else if (FLAGS[`-${letter}`]) o[FLAGS[`-${letter}`]] = true }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) throw new Failure(`E: Command line option '${arg}' is not understood in combination with the other options.`, 100)
    if (verb === undefined) verb = arg
    else o.targets.push(arg)
  }
  o.verb = verb
  return o
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

/** The lines apt prints while it reads the package state */
function reading(o) {
  if (o.quiet) return
  out('Reading package lists... Done')
  out('Building dependency tree... Done')
  out('Reading state information... Done')
}

const say = (o, text) => { if (o.quiet < 2) out(text) }

/** The session, with a note when a user without root installs for themselves */
function open(o, command) {
  if (o.global && !isRoot()) throw new Failure('E: this needs root', 100)
  const session = openSession(o)
  if (!session.scope.system && o.verb && ['install', 'reinstall', 'remove', 'purge', 'autoremove', 'autopurge', 'upgrade', 'full-upgrade', 'dist-upgrade', 'update'].includes(o.verb) && !o.simulate) {
    say(o, `N: Not running as root: ${command} works on ${tilde(session.scope.lib)} (use sudo for the whole system).`)
  }
  return session
}

/** `a b c` with each package named the way the user would: as asked for, else the index's name for a package it maps, else npm's */
function namesOf(session, nodes, asked = new Map()) {
  return nodes.map(node => asked.get(node.name) ?? displayName(session, 'apt', node)).sort()
}

const sizeLine = bytes => (bytes ? kilobytes(bytes) : '0 B')

/** Resolves `requests`, reporting a failure the way apt does */
async function resolve(session, requests) {
  try {
    return await session.engine.resolve(requests)
  } catch (error) {
    throw new Failure(`E: ${error instanceof Error ? error.message : String(error)}`, 100)
  }
}

/** Says why a name cannot be installed, and what npm has that is close; throws when any name is missing */
async function refuse(session, o, { provided, missing }, verb) {
  for (const { name, note } of provided) say(o, `${name} is already the newest version (${note}).`)
  if (!missing.length) return
  for (const name of missing) err(`E: Unable to locate package ${name}`)
  for (const name of missing) {
    const close = await suggest(session, name)
    if (!close.length) continue
    err(`N: '${name}' is not in the package index. Packages on npm that look close:`)
    for (const found of close) err(`N:   ${found.name} ${found.version}${found.description ? ` - ${found.description.slice(0, 60)}` : ''}`)
    err(`N: Install one by its npm name, for example: ${verb === 'remove' ? 'install remove' : 'install'} ${close[0].name}`)
  }
  throw new Failure('', 100)
}

async function install(session, o, command) {
  if (!o.targets.length) return 0
  reading(o)
  const found = translate(session, 'apt', o.targets)
  await refuse(session, o, found, 'install')
  if (!found.requests.length) return 0
  const { engine, db } = session
  if (o.reinstall || o.verb === 'reinstall') engine.options.reinstall = true
  const plan = await resolve(session, found.requests)
  const changes = engine.changes(plan)
  const asked = new Map(found.requests.map(request => [request.name, request.asked]))
  for (const node of changes.already) say(o, `${asked.get(node.name) ?? displayName(session, 'apt', node)} is already the newest version (${node.version}).`)
  const notUpgraded = cachedUpgradable(session.registry, db.explicit()).filter(entry => !changes.upgraded.some(node => node.name === entry.name)).length
  const total = (upgraded, added, again) => `${upgraded} upgraded, ${added} newly installed, ${again ? `${again} reinstalled, ` : ''}0 to remove and ${notUpgraded} not upgraded.`
  if (!changes.fresh.length) { say(o, total(0, 0, 0)); return 0 }

  if (changes.added.length) say(o, `The following NEW packages will be installed:\n${wrap(namesOf(session, changes.added, asked))}`)
  if (changes.upgraded.length) say(o, `The following packages will be upgraded:\n${wrap(namesOf(session, changes.upgraded, asked))}`)
  if (changes.reinstalled.length) say(o, `The following packages will be REINSTALLED:\n${wrap(namesOf(session, changes.reinstalled, asked))}`)
  say(o, total(changes.upgraded.length, changes.added.length, changes.reinstalled.length))
  const bytes = changes.fresh.reduce((sum, node) => sum + (node.dist?.unpackedSize ?? 0), 0)
  say(o, `After this operation, ${sizeLine(bytes)} of additional disk space will be used.`)

  if (o.simulate) {
    for (const node of changes.fresh) out(`Inst ${displayName(session, 'apt', node)} (${node.version} ${session.registry.url.replace(/^https?:\/\//, '')} [all])`)
    for (const node of changes.fresh) out(`Conf ${displayName(session, 'apt', node)} (${node.version} ${session.registry.url.replace(/^https?:\/\//, '')} [all])`)
    return 0
  }
  if (!o.yes && !confirm('Do you want to continue?')) { out('Abort.'); return 1 }

  if (!o.quiet) changes.fresh.forEach((node, index) => out(`Get:${index + 1} ${session.registry.url} ${node.name} ${node.version} [${node.dist?.unpackedSize ? kilobytes(node.dist.unpackedSize) : 'local'}]`))
  const before = new Map(changes.upgraded.map(node => [node.name, db.versionsOf(node.name)[0]?.version]))
  engine.options.placed = node => {
    const name = displayName(session, 'apt', node)
    if (o.quiet >= 2) return
    if (before.has(node.name)) out(`Preparing to unpack ... ${name} (${before.get(node.name)}) over (${node.version}) ...`)
    else out(`Selecting previously unselected package ${name}.`)
    out(`Unpacking ${name} (${node.version}) ...`)
    out(`Setting up ${name} (${node.version}) ...`)
  }
  const code = await engine.apply(plan)
  if (code) throw new Failure(`E: Sub-process ${command} returned an error code (${code})`, 100)
  for (const node of changes.fresh) {
    if (manifestOf(session.scope, node).ecmaos?.source) say(o, `N: The source of ${asked.get(node.name) ?? displayName(session, 'apt', node)} is a package of its own: apt source ${asked.get(node.name) ?? displayName(session, 'apt', node)}`)
  }
  return 0
}

/**
 * `apt source NAME`: fetches the source package of a program (`@ecmaos-apps/NAME-src`, the Corresponding Source of a
 * copyleft binary: the upstream archives, the patches and the build recipe) and unpacks it into `./NAME-VERSION`.
 */
async function source(session, o) {
  if (!o.targets.length) throw new Failure('E: Must specify at least one package to fetch source for', 100)
  reading(o)
  const found = translate(session, 'apt', o.targets)
  await refuse(session, o, found, 'install')
  const { registry } = session
  for (const { name: binary, range, asked } of found.requests) {
    const name = `${binary}-src`
    let document
    try { document = await registry.metadata(name) } catch {
      throw new Failure(`E: Unable to find a source package for ${asked ?? binary}`, 100)
    }
    const version = pickVersion(document, range)
    const dist = document.versions?.[version]?.dist
    if (!version || !dist) throw new Failure(`E: Unable to find a source package for ${asked ?? binary}${range ? ` (${range})` : ''}`, 100)
    if (!o.ignoreSignatures) {
      const problem = await verifySignature(registry.url, name, version, dist)
      if (problem) throw new Failure(`E: ${problem}`, 100)
    }
    const unsigned = await session.engine.unsigned(name, version, dist, !range)
    if (unsigned) throw new Failure(`E: ${unsigned}`, 100)
    const tarball = await registry.tarball(name, version, dist, bytes => verifyIntegrity(bytes, dist))
    const directory = join(getcwd(), `${asked ?? binary.split('/').pop()}-${version}`)
    if (exists(directory)) throw new Failure(`E: ${directory} already exists`, 100)
    say(o, `Get:1 ${registry.url} ${name} ${version} [${dist.unpackedSize ? kilobytes(dist.unpackedSize) : 'unknown size'}]`)
    const scratch = join(getcwd(), `.source-${getpid()}`)
    try {
      mkdirp(scratch)
      if (await untar(tarball.path, scratch) !== 0) throw new Failure(`E: ${name}@${version} cannot be unpacked`, 100)
      rename(join(scratch, 'package'), directory)
    } finally {
      try { rmRecursive(scratch) } catch { /* never made */ }
    }
    say(o, `dpkg-source: info: extracting ${name} in ${tilde(directory)}`)
  }
  return 0
}

function orphanNotice(session, o, command) {
  const orphans = session.db.orphans()
  if (!orphans.length) return
  say(o, `The following packages were automatically installed and are no longer required:\n${wrap(namesOf(session, orphans))}\nUse '${isRoot() ? '' : 'sudo '}${command} autoremove' to remove ${orphans.length === 1 ? 'it' : 'them'}.`)
}

async function remove(session, o, command) {
  if (!o.targets.length) return 0
  reading(o)
  const found = translate(session, 'apt', o.targets)
  for (const { name } of found.provided) err(`E: ${name} is part of ecmaOS and cannot be removed`)
  if (found.provided.length) throw new Failure('', 100)
  await refuse(session, o, { provided: [], missing: found.missing }, 'remove')
  const { engine, db } = session
  const targets = []
  for (const request of found.requests) {
    const entries = db.versionsOf(request.name)
    if (entries.length) targets.push(...entries)
    else say(o, `Package '${request.asked}' is not installed, so not removed`)
  }
  const notUpgraded = cachedUpgradable(session.registry, db.explicit()).filter(entry => !targets.some(target => target.name === entry.name)).length
  if (!targets.length) { say(o, `0 upgraded, 0 newly installed, 0 to remove and ${notUpgraded} not upgraded.`); return 0 }
  say(o, `The following packages will be REMOVED:\n${wrap(namesOf(session, targets))}`)
  say(o, `0 upgraded, 0 newly installed, ${targets.length} to remove and ${notUpgraded} not upgraded.`)
  const freed = targets.reduce((sum, entry) => sum + sizeOf(directoryOf(session.scope, entry)), 0)
  say(o, `After this operation, ${sizeLine(freed)} disk space will be freed.`)
  if (o.simulate) { for (const entry of targets) out(`Remv ${displayName(session, 'apt', entry)} [${entry.version}]`); return 0 }
  if (!o.yes && !confirm('Do you want to continue?')) { out('Abort.'); return 1 }
  for (const entry of targets) say(o, `Removing ${displayName(session, 'apt', entry)} (${entry.version}) ...`)
  const code = await engine.remove(found.requests.map(request => request.name), { autoremove: o.autoremove || o.verb === 'autopurge' })
  if (code) throw new Failure('', 100)
  if (!o.autoremove) orphanNotice(session, o, command)
  return 0
}

async function autoremove(session, o) {
  reading(o)
  const orphans = session.db.orphans()
  const notUpgraded = cachedUpgradable(session.registry, session.db.explicit()).length
  if (!orphans.length) { say(o, `0 upgraded, 0 newly installed, 0 to remove and ${notUpgraded} not upgraded.`); return 0 }
  say(o, `The following packages will be REMOVED:\n${wrap(namesOf(session, orphans))}`)
  say(o, `0 upgraded, 0 newly installed, ${orphans.length} to remove and ${notUpgraded} not upgraded.`)
  if (o.simulate) { for (const entry of orphans) out(`Remv ${displayName(session, 'apt', entry)} [${entry.version}]`); return 0 }
  if (!o.yes && !confirm('Do you want to continue?')) { out('Abort.'); return 1 }
  for (const entry of orphans) say(o, `Removing ${displayName(session, 'apt', entry)} (${entry.version}) ...`)
  const ok = session.engine.autoremove(true)
  session.db.save()
  if (!ok) throw new Failure('', 100)
  return 0
}

async function update(session, o) {
  const registry = session.registry.url
  let line
  try {
    const result = await refreshIndex(session.registry, session.scope, { ignoreSignatures: o.ignoreSignatures })
    line = result.updated ? `Get:1 ${registry} @ecmaos/package-index ${result.version} [${kilobytes(result.bytes)}]` : `Hit:1 ${registry} @ecmaos/package-index ${result.version}`
    if (result.updated && !o.quiet) {
      out(line)
      out(`Fetched ${kilobytes(result.bytes)}`)
      line = undefined
    }
  } catch (error) {
    err(`Err:1 ${registry} @ecmaos/package-index`)
    err(`W: Failed to fetch the package index: ${error instanceof Error ? error.message : String(error)}`)
    err('W: Using the package index built into ecmaOS.')
  }
  if (line && !o.quiet) out(line)
  const latest = await latestOf(session.registry, session.db.all(), message => err(`W: ${message}`))
  reading(o)
  const count = newer(session.db.explicit(), latest).length
  if (count) say(o, `${plural(count, 'package')} can be upgraded. Run '${isRoot() ? '' : 'sudo '}apt list --upgradable' to see ${count === 1 ? 'it' : 'them'}.`)
  else say(o, 'All packages are up to date.')
  return 0
}

async function upgrade(session, o, command) {
  reading(o)
  const latest = await latestOf(session.registry, session.db.upgradable(), message => err(`W: ${message}`))
  const due = newer(session.db.upgradable(), latest)
  say(o, 'Calculating upgrade... Done')
  if (!due.length) { say(o, '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.'); return 0 }
  const plan = await resolve(session, due.map(entry => ({ name: entry.name, range: latest[entry.name].latest })))
  const changes = session.engine.changes(plan)
  say(o, `The following packages will be upgraded:\n${wrap(namesOf(session, changes.upgraded.length ? changes.upgraded : due))}`)
  say(o, `${changes.upgraded.length} upgraded, ${changes.added.length} newly installed, 0 to remove and 0 not upgraded.`)
  say(o, `After this operation, ${sizeLine(changes.fresh.reduce((sum, node) => sum + (node.dist?.unpackedSize ?? 0), 0))} of additional disk space will be used.`)
  if (o.simulate) { for (const node of changes.fresh) out(`Inst ${displayName(session, 'apt', node)} (${node.version} ${session.registry.url.replace(/^https?:\/\//, '')} [all])`); return 0 }
  if (!o.yes && !confirm('Do you want to continue?')) { out('Abort.'); return 1 }
  const before = new Map(changes.upgraded.map(node => [node.name, session.db.versionsOf(node.name)[0]?.version]))
  session.engine.options.placed = node => {
    const name = displayName(session, 'apt', node)
    if (o.quiet >= 2) return
    out(before.has(node.name) ? `Preparing to unpack ... ${name} (${before.get(node.name)}) over (${node.version}) ...` : `Selecting previously unselected package ${name}.`)
    out(`Unpacking ${name} (${node.version}) ...`)
    out(`Setting up ${name} (${node.version}) ...`)
  }
  const code = await session.engine.apply(plan)
  if (code) throw new Failure(`E: Sub-process ${command} returned an error code (${code})`, 100)
  return 0
}

function clean(session, o) {
  const { rmRecursive } = globalThis.ecmaosSyscalls
  for (const directory of ['tarballs', 'meta']) try { rmRecursive(`${session.scope.cache}/${directory}`) } catch { /* already empty */ }
  say(o, '')
  return 0
}

/** `name/stable,now 1.0.0 all [installed]`, as `apt list` shows a package */
function listLine(name, version, state) {
  return `${name}/stable${state.includes('installed') ? ',now' : ''} ${version} all${state.length ? ` [${state.join(',')}]` : ''}`
}

async function list(session, o) {
  out('Listing... Done')
  const rows = new Map()
  const present = installed(session)
  // what is newer comes from the metadata `apt update` cached: listing does not ask the registry
  const upgradable = new Map(cachedUpgradable(session.registry, present.map(row => row.entry)).map(entry => [entry.name, session.registry.cached(entry.name)['dist-tags'].latest]))
  for (const { entry } of present) {
    const name = displayName(session, 'apt', entry)
    const newest = upgradable.get(entry.name)
    const state = newest ? [`upgradable from: ${entry.version}`] : ['installed', ...(entry.explicit ? [] : ['automatic'])]
    rows.set(name, listLine(name, newest ?? entry.version, state))
  }
  if (!o.installed && !o.upgradable) {
    for (const [name, entry] of entries(session.index, 'apt')) {
      if (rows.has(name) || entry.provided) continue
      const cached = session.registry.cached(entry.package)?.['dist-tags']?.latest
      rows.set(name, listLine(name, cached ?? 'unknown', []))
    }
  }
  const pattern = o.targets[0]
  const wanted = [...rows.entries()].filter(([name, line]) => (!pattern || name.includes(pattern.replace(/[*]/g, ''))) && (!o.upgradable || line.includes('upgradable')))
  for (const [, line] of wanted.sort((a, b) => a[0].localeCompare(b[0]))) out(line)
  return 0
}

/** A package's `Package:` / `Version:` fields from the registry (or, offline, from what is installed) */
async function showOne(session, o, text) {
  const found = translate(session, 'apt', [text])
  if (found.provided.length) {
    out(`Package: ${found.provided[0].name}\nVersion: (ecmaOS)\nPriority: required\nSection: base\nOrigin: ecmaOS\nDescription: ${found.provided[0].note}\n`)
    return true
  }
  if (!found.requests.length) { err(`E: No packages found`); err(`N: Unable to locate package ${found.missing[0]}`); return false }
  const request = found.requests[0]
  let document
  try { document = await session.registry.document(request.name) } catch { document = undefined }
  const local = session.db.versionsOf(request.name)[0]
  const version = document ? pickVersion(document, request.range) : local?.version
  const manifest = document?.versions?.[version] ?? (local ? manifestOf(session.scope, local) : undefined)
  if (!manifest) { err(`E: No packages found`); err(`N: Could not read ${request.name} from ${session.registry.url}`); return false }
  const maintainer = document?.maintainers?.[0]
  const lines = [
    `Package: ${found.requests[0].asked}`,
    `Version: ${version}`,
    'Priority: optional',
    'Section: node',
    'Origin: npm',
    ...(maintainer ? [`Maintainer: ${typeof maintainer === 'string' ? maintainer : `${maintainer.name}${maintainer.email ? ` <${maintainer.email}>` : ''}`}`] : []),
    ...(manifest.dist?.unpackedSize ? [`Installed-Size: ${kilobytes(manifest.dist.unpackedSize)}`] : []),
    ...(Object.keys(manifest.dependencies ?? {}).length ? [`Depends: ${dependsOf(manifest, session, 'apt').join(', ')}`] : []),
    ...(manifest.homepage ?? document?.homepage ? [`Homepage: ${manifest.homepage ?? document.homepage}`] : []),
    `APT-Sources: ${session.registry.url} stable/main`,
    `Npm-Package: ${request.name}`,
    `Description: ${String(manifest.description ?? document?.description ?? 'no description').replace(/\s+/g, ' ')}`
  ]
  out(lines.join('\n') + '\n')
  return true
}

async function show(session, o) {
  if (!o.targets.length) throw new Failure(`E: No packages found`, 100)
  let ok = true
  for (const target of o.targets) ok = (await showOne(session, o, target)) && ok
  return ok ? 0 : 100
}

async function search(session, o) {
  if (!o.targets.length) throw new Failure('E: You must give at least one search pattern', 100)
  const terms = o.targets.map(term => term.toLowerCase())
  const shown = new Set()
  out('Sorting... Done')
  out('Full Text Search... Done')
  const lines = []
  for (const [name, entry] of entries(session.index, 'apt')) {
    const text = `${name} ${entry.package ?? ''} ${entry.description ?? entry.provided ?? ''}`.toLowerCase()
    if (!terms.every(term => text.includes(term))) continue
    shown.add(entry.package ?? name)
    const have = installed(session).some(({ entry: row }) => row.name === entry.package)
    const version = entry.provided ? '(ecmaOS)' : (session.registry.cached(entry.package)?.['dist-tags']?.latest ?? 'unknown')
    lines.push([name, `${name}/stable${have ? ',now' : ''} ${version} all${have ? ' [installed]' : ''}\n  ${entry.description ?? entry.provided}\n`])
  }
  try {
    for (const found of await session.registry.search(o.targets.join(' '), 10)) {
      if (shown.has(found.name)) continue
      const have = installed(session).some(({ entry: row }) => row.name === found.name)
      lines.push([found.name, `${found.name}/npm${have ? ',now' : ''} ${found.version} all${have ? ' [installed]' : ''}\n  ${String(found.description ?? '').replace(/\s+/g, ' ')}\n`])
    }
  } catch (error) {
    err(`W: Could not search ${session.registry.url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const [, text] of lines.sort((a, b) => a[0].localeCompare(b[0]))) out(text)
  return 0
}

async function policy(session, o) {
  const targets = o.targets.length ? o.targets : []
  if (!targets.length) {
    out(`Package files:\n 500 ${session.registry.url} stable/main`)
    return 0
  }
  for (const target of targets) {
    const found = translate(session, 'apt', [target])
    if (found.provided.length) { out(`${found.provided[0].name}:\n  Installed: (ecmaOS)\n  Candidate: (ecmaOS)`); continue }
    if (!found.requests.length) { err(`N: Unable to locate package ${found.missing[0]}`); continue }
    const request = found.requests[0]
    let candidate
    try { candidate = pickVersion(await session.registry.metadata(request.name), request.range) } catch { candidate = session.registry.cached(request.name)?.['dist-tags']?.latest }
    const have = session.db.versionsOf(request.name)[0]
    const lines = [`${request.asked}:`, `  Installed: ${have ? have.version : '(none)'}`, `  Candidate: ${candidate ?? '(none)'}`, '  Version table:']
    if (candidate) lines.push(`${have?.version === candidate ? ' *** ' : '     '}${candidate} 500`, `        500 ${session.registry.url} stable/main`)
    if (have && have.version !== candidate) lines.push(` *** ${have.version} 100`, '        100 /var/lib/install/db.json')
    out(lines.join('\n'))
  }
  return 0
}

async function depends(session, o) {
  if (!o.targets.length) throw new Failure('E: No packages found', 100)
  for (const target of o.targets) {
    const found = translate(session, 'apt', [target])
    if (!found.requests.length) { err(`E: No packages found`); continue }
    const request = found.requests[0]
    const have = session.db.versionsOf(request.name)[0]
    let manifest = have ? manifestOf(session.scope, have) : undefined
    if (!manifest) {
      const document = await session.registry.metadata(request.name)
      manifest = document.versions[pickVersion(document, request.range)]
    }
    out(`${request.asked}\n${Object.entries(manifest.dependencies ?? {}).map(([name, range]) => `  Depends: ${nameFor(session.index, 'apt', name)}${range && range !== '*' ? ` (${range})` : ''}`).join('\n')}`.trimEnd())
  }
  return 0
}

async function rdepends(session, o) {
  if (!o.targets.length) throw new Failure('E: No packages found', 100)
  for (const target of o.targets) {
    const found = translate(session, 'apt', [target])
    if (!found.requests.length) { err('E: No packages found'); continue }
    out(`${found.requests[0].asked}\nReverse Depends:`)
    for (const entry of session.db.versionsOf(found.requests[0].name)) {
      for (const other of session.db.dependentsOf(entry.name, entry.version)) out(`  ${displayName(session, 'apt', other)}`)
    }
  }
  return 0
}

function pkgnames(session) {
  const names = new Set(entries(session.index, 'apt').filter(([, entry]) => entry.package).map(([name]) => name))
  for (const { entry } of installed(session)) names.add(displayName(session, 'apt', entry))
  for (const name of [...names].sort()) out(name)
  return 0
}

export async function run(command, args) {
  try {
    const o = parse(command, args)
    if (o.version) { out(`${command} 2.9 (ecmaOS, on npm's registry)`); return 0 }
    if (o.help || !o.verb) { out(usage(command)); return o.help || o.verb ? 0 : 1 }
    const verbs = VERBS[command]
    if (!verbs.includes(o.verb)) throw new Failure(`E: Invalid operation ${o.verb}`, 100)
    const needsSession = o.verb !== 'check'
    const session = needsSession ? open(o, command) : openSession(o)
    switch (o.verb) {
      case 'update': return await update(session, o)
      case 'upgrade': case 'full-upgrade': case 'dist-upgrade': return await upgrade(session, o, command)
      case 'install': case 'reinstall': return await install(session, o, command)
      case 'remove': case 'purge': return await remove(session, o, command)
      case 'autoremove': case 'autopurge': return await autoremove(session, o)
      case 'clean': case 'autoclean': return clean(session, o)
      case 'check': reading(o); return 0
      case 'list': return await list(session, o)
      case 'search': return await search(session, o)
      case 'show': return await show(session, o)
      case 'policy': return await policy(session, o)
      case 'depends': return await depends(session, o)
      case 'rdepends': return await rdepends(session, o)
      case 'pkgnames': return pkgnames(session)
      case 'source': return await source(session, o)
    }
    return 0
  } catch (error) {
    if (error instanceof Failure) { if (error.message) err(error.message); return error.code }
    err(`E: ${error instanceof Error ? error.message : String(error)}`)
    return 100
  }
}
