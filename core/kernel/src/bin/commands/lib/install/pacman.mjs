/**
 * `pacman` over `install`'s engine. The names are Arch's (the index maps them to npm packages); the operations are
 * pacman's: `-S` sync (install, `-y` refresh, `-u` upgrade, `-s` search, `-i` info, `-l` list, `-c` clean), `-R` remove,
 * `-Q` query, `-U` install a local tarball. Output is shaped like pacman's.
 */

import semver from 'semver'

import { resolve } from '../path-utils.mjs'
import { exists } from './io.mjs'
import { pickVersion } from './engine.mjs'
import { entries, refreshIndex } from './names.mjs'
import { cachedUpgradable, latestOf, newer } from './updates.mjs'
import {
  Failure, confirm, descriptionOf, directoryOf, displayName, err, installed, isRoot, manifestOf, openSession, out, ownedPaths, ownerOf, sizeOf, suggest, tilde,
  translate
} from './frontend.mjs'

const { getcwd, rmRecursive } = globalThis.ecmaosSyscalls

const usage = `usage:  pacman <operation> [...]
operations:
    pacman {-h --help}
    pacman {-V --version}
    pacman {-Q --query}   [options] [package(s)]
    pacman {-R --remove}  [options] <package(s)>
    pacman {-S --sync}    [options] [package(s)]
    pacman {-U --upgrade} [options] <file(s)>

options:
    --noconfirm      do not ask for any confirmation
    --needed         do not reinstall up to date targets
    --registry=URL   npm registry to use (default: $REGISTRY, else https://registry.npmjs.org)
    --user           work on your own packages (~/.local), even as root
    --offline        use only the cache`

const LONG = {
  '--sync': 'S', '--remove': 'R', '--query': 'Q', '--upgrade': 'U', '--help': 'h', '--version': 'V', '--files': 'F', '--database': 'D', '--deptest': 'T',
  '--refresh': 'y', '--sysupgrade': 'u', '--search': 's', '--info': 'i', '--list': 'l', '--clean': 'c', '--recursive': 's', '--nosave': 'n',
  '--explicit': 'e', '--deps': 'd', '--unrequired': 't', '--owns': 'o', '--quiet': 'q', '--upgrades': 'u'
}
const TAKES_VALUE = new Set(['--dbpath', '-b', '--root', '-r', '--cachedir', '--config', '--arch', '--color', '--logfile', '--gpgdir', '--hookdir', '--ignore', '--ignoregroup', '--overwrite', '--assume-installed', '--sysroot'])

function parse(args) {
  const o = { operands: [], letters: [] }
  const flag = letter => { o.letters.push(letter) }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { o.operands.push(...args.slice(i + 1)); break }
    if (arg === '--registry') { o.registry = args[++i]; continue }
    if (arg.startsWith('--registry=')) { o.registry = arg.slice(11); continue }
    if (arg === '--noconfirm') { o.noconfirm = true; continue }
    if (arg === '--needed') { o.needed = true; continue }
    if (arg === '--user') { o.user = true; continue }
    if (arg === '--offline') { o.offline = true; continue }
    if (arg === '--ignore-signatures') { o.ignoreSignatures = true; continue }
    if (arg === '--allow-scripts') { o.allowScripts = true; continue }
    if (['--noprogressbar', '--noscriptlet', '--asdeps', '--asexplicit', '--debug', '--verbose', '--print', '--dbonly', '--nodeps'].includes(arg) || arg.startsWith('--color=') || arg.startsWith('--ignore=')) continue
    if (TAKES_VALUE.has(arg)) { i++; continue }
    if (LONG[arg]) { flag(LONG[arg]); continue }
    if (arg.startsWith('--')) throw new Failure(`error: invalid option '${arg}'`, 1)
    if (arg.startsWith('-') && arg.length > 1) {
      for (const letter of arg.slice(1)) flag(letter)
      continue
    }
    o.operands.push(arg)
  }
  const operation = o.letters.find(letter => 'SRQUFDTVh'.includes(letter))
  o.operation = operation
  o.has = letter => o.letters.includes(letter) && letter !== operation
  return o
}

const mib = bytes => `${(bytes / 1048576).toFixed(2)} MiB`
const label = (session, entry) => `${displayName(session, 'pacman', entry)}-${entry.version}`

function open(o) {
  if (o.global && !isRoot()) throw new Failure('error: you cannot perform this operation unless you are root.', 1)
  const session = openSession(o)
  if (!session.scope.system && 'SRU'.includes(o.operation)) out(`warning: not running as root: working on ${tilde(session.scope.lib)} (use sudo for the whole system)`)
  return session
}

function ask(o, question) {
  if (!o.noconfirm) return confirm(`:: ${question}`)
  out(`:: ${question} [Y/n]`)
  return true
}

/** Install: `-S NAME...`, and `-U FILE...` */
async function carryOut(session, o, requests, { local = false } = {}) {
  const { engine, db } = session
  if (!local && !o.needed) {
    for (const request of requests) {
      const have = db.versionsOf(request.name)[0]
      if (have && (!request.range || semver.satisfies(have.version, request.range))) {
        out(`warning: ${request.asked}-${have.version} is up to date -- reinstalling`)
        engine.options.reinstall = true
      }
    }
  }
  out('resolving dependencies...')
  let plan
  try { plan = await engine.resolve(requests) } catch (error) { throw new Failure(`error: ${error instanceof Error ? error.message : String(error)}`, 1) }
  const changes = engine.changes(plan)
  for (const node of changes.already) out(`warning: ${displayName(session, 'pacman', node)}-${node.version} is up to date -- skipping`)
  if (!changes.fresh.length) { out(' there is nothing to do'); return 0 }
  out('looking for conflicting packages...\n')
  const asked = new Map(requests.map(request => [request.name, request.asked]))
  const names = changes.fresh.map(node => `${asked.get(node.name) ?? displayName(session, 'pacman', node)}-${node.version}`).sort()
  out(`Packages (${names.length}) ${names.join('  ')}\n`)
  const bytes = changes.fresh.reduce((sum, node) => sum + (node.dist?.unpackedSize ?? 0), 0)
  out(`Total Installed Size:  ${mib(bytes)}\n`)
  if (!ask(o, 'Proceed with installation?')) { out('error: Operation cancelled by user'); return 1 }
  let index = 0
  engine.options.placed = node => out(`(${++index}/${changes.fresh.length}) installing ${asked.get(node.name) ?? displayName(session, 'pacman', node)}`)
  out(':: Processing package changes...')
  const code = await engine.apply(plan)
  return code ? 1 : 0
}

async function sync(session, o) {
  const refresh = o.has('y')
  if (o.has('c')) {
    out(`Cache directory: ${session.scope.cache}`)
    if (!ask(o, 'Do you want to remove all other packages from cache?')) return 1
    out('removing old packages from cache...')
    for (const directory of ['tarballs', 'meta']) try { rmRecursive(`${session.scope.cache}/${directory}`) } catch { /* already empty */ }
    return 0
  }
  if (refresh) {
    out(':: Synchronizing package databases...')
    try {
      const result = await refreshIndex(session.registry, session.scope, { ignoreSignatures: o.ignoreSignatures })
      out(result.updated ? ` package-index ${(result.bytes / 1024).toFixed(1)} KiB` : ' package-index is up to date')
    } catch (error) {
      out(` package-index is up to date`)
      err(`warning: could not refresh the package index (${error instanceof Error ? error.message : String(error)}); using the one built in`)
    }
    await latestOf(session.registry, session.db.all(), message => err(`warning: ${message}`))
  }
  if (o.has('u')) return await upgrade(session, o)
  if (o.has('s')) return await searchSync(session, o)
  if (o.has('i')) return await infoSync(session, o)
  if (o.has('l')) return listSync(session, o)
  if (!o.operands.length) return refresh ? 0 : fail('error: no targets specified (use -h for help)')
  const found = translate(session, 'pacman', o.operands)
  for (const { name } of found.provided) out(`warning: ${name} is part of ecmaOS -- skipping`)
  if (found.missing.length) {
    for (const name of found.missing) err(`error: target not found: ${name}`)
    for (const name of found.missing) {
      for (const close of await suggest(session, name)) err(`hint: ${close.name} ${close.version} is on npm (install ${close.name})`)
    }
    return 1
  }
  if (!found.requests.length) return 0
  return await carryOut(session, o, found.requests)
}

function fail(message) { throw new Failure(message, 1) }

async function upgrade(session, o) {
  out(':: Starting full system upgrade...')
  const latest = await latestOf(session.registry, session.db.explicit(), message => err(`warning: ${message}`))
  const due = newer(session.db.explicit(), latest)
  if (!due.length) { out(' there is nothing to do'); return 0 }
  return await upgradeTo(session, o, due, latest)
}

async function upgradeTo(session, o, due, latest) {
  const requests = due.map(entry => ({ name: entry.name, range: latest[entry.name].latest, asked: displayName(session, 'pacman', entry) }))
  return await carryOut(session, { ...o, needed: true }, requests)
}

function cachedVersion(session, name) { return session.registry.cached(name)?.['dist-tags']?.latest }

async function searchSync(session, o) {
  if (!o.operands.length) return fail('error: no targets specified (use -h for help)')
  const tests = o.operands.map(term => { try { return new RegExp(term, 'i') } catch { return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } })
  const have = installed(session)
  let found = 0
  for (const [name, entry] of entries(session.index, 'pacman')) {
    if (!tests.every(test => test.test(name) || test.test(entry.description ?? entry.provided ?? ''))) continue
    found++
    const version = entry.provided ? 'ecmaos' : (cachedVersion(session, entry.package) ?? 'unknown')
    const mark = have.some(({ entry: row }) => row.name === entry.package) ? ' [installed]' : ''
    out(o.has('q') ? name : `npm/${name} ${version}${mark}\n    ${entry.description ?? entry.provided}`)
  }
  try {
    for (const result of await session.registry.search(o.operands.join(' '), 10)) {
      if (entries(session.index, 'pacman').some(([, entry]) => entry.package === result.name)) continue
      found++
      const mark = have.some(({ entry: row }) => row.name === result.name) ? ' [installed]' : ''
      out(o.has('q') ? result.name : `npm/${result.name} ${result.version}${mark}\n    ${String(result.description ?? '').replace(/\s+/g, ' ')}`)
    }
  } catch (error) {
    err(`warning: could not search ${session.registry.url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return found ? 0 : 1
}

function listSync(session, o) {
  const have = installed(session)
  for (const [name, entry] of entries(session.index, 'pacman')) {
    if (entry.provided) continue
    if (o.operands.length && !o.operands.includes('npm')) continue
    const installedNow = have.find(({ entry: row }) => row.name === entry.package)
    out(`npm ${name} ${cachedVersion(session, entry.package) ?? 'unknown'}${installedNow ? ' [installed]' : ''}`)
  }
  return 0
}

function infoLines(fields) {
  const width = Math.max(...fields.map(([key]) => key.length))
  return fields.map(([key, value]) => `${key.padEnd(Math.max(width, 15))} : ${value}`).join('\n')
}

async function infoSync(session, o) {
  if (!o.operands.length) return fail('error: no targets specified (use -h for help)')
  let code = 0
  for (const operand of o.operands) {
    const found = translate(session, 'pacman', [operand])
    if (found.provided.length) { out(infoLines([['Repository', 'ecmaos'], ['Name', operand], ['Description', found.provided[0].note]]) + '\n'); continue }
    if (!found.requests.length) { err(`error: package '${operand}' was not found`); code = 1; continue }
    const request = found.requests[0]
    let document
    try { document = await session.registry.document(request.name) } catch (error) { err(`error: ${error instanceof Error ? error.message : String(error)}`); code = 1; continue }
    const version = pickVersion(document, request.range)
    const manifest = document.versions?.[version]
    if (!manifest) { err(`error: package '${operand}' was not found`); code = 1; continue }
    const dependencies = Object.keys(manifest.dependencies ?? {}).map(name => displayName(session, 'pacman', { name }))
    out(infoLines([
      ['Repository', 'npm'], ['Name', operand], ['Version', version], ['Description', String(manifest.description ?? document.description ?? 'None').replace(/\s+/g, ' ')],
      ['Architecture', 'any'], ['URL', manifest.homepage ?? document.homepage ?? 'None'], ['Licenses', manifest.license ?? document.license ?? 'None'], ['Groups', 'None'],
      ['Provides', 'None'], ['Depends On', dependencies.join('  ') || 'None'], ['Optional Deps', 'None'], ['Conflicts With', 'None'], ['Replaces', 'None'],
      ['Download Size', 'N/A'], ['Installed Size', manifest.dist?.unpackedSize ? mib(manifest.dist.unpackedSize) : 'N/A'],
      ['Packager', document.maintainers?.[0]?.name ?? 'Unknown Packager'], ['Build Date', document.time?.[version] ?? 'None'],
      ['Validated By', manifest.dist?.signatures?.length ? 'SHA-512 Integrity  npm Signature' : 'SHA-512 Integrity']
    ]) + '\n')
  }
  return code
}

async function remove(session, o) {
  if (!o.operands.length) return fail('error: no targets specified (use -h for help)')
  const targets = []
  for (const operand of o.operands) {
    const found = translate(session, 'pacman', [operand])
    const name = found.requests[0]?.name ?? (session.db.versionsOf(operand).length ? operand : undefined)
    const entries = name ? session.db.versionsOf(name) : []
    if (!entries.length) { err(`error: target not found: ${operand}`); return 1 }
    targets.push(...entries)
  }
  const recursive = o.has('s')
  out('checking dependencies...\n')
  const names = targets.map(entry => label(session, entry)).sort()
  out(`Packages (${names.length}) ${names.join('  ')}\n`)
  out(`Total Removed Size:  ${mib(targets.reduce((sum, entry) => sum + sizeOf(directoryOf(session.scope, entry)), 0))}\n`)
  if (!ask(o, 'Do you want to remove these packages?')) { out('error: Operation cancelled by user'); return 1 }
  out(':: Processing package changes...')
  targets.forEach((entry, index) => out(`(${index + 1}/${targets.length}) removing ${displayName(session, 'pacman', entry)}`))
  return await session.engine.remove([...new Set(targets.map(entry => entry.name))], { autoremove: recursive }) ? 1 : 0
}

async function upgradeLocal(session, o) {
  if (!o.operands.length) return fail('error: no targets specified (use -h for help)')
  const requests = []
  for (const operand of o.operands) {
    const path = resolve(getcwd(), operand)
    if (!exists(path)) return fail(`error: '${operand}': could not find or read package`)
    if (/\.pkg\.tar(\.\w+)?$/.test(operand)) return fail(`error: '${operand}': ecmaOS packages are npm tarballs (.tgz)`)
    const local = await session.engine.local(path)
    requests.push({ name: path, local, asked: local.name })
  }
  return await carryOut(session, o, requests, { local: true })
}

function lineOf(session, o, { entry }) {
  const name = displayName(session, 'pacman', entry)
  return o.has('q') ? name : `${name} ${entry.version}`
}

async function query(session, o) {
  let have = installed(session).sort((a, b) => displayName(session, 'pacman', a.entry).localeCompare(displayName(session, 'pacman', b.entry)))
  if (o.has('o')) {
    let code = 0
    if (!o.operands.length) return fail('error: no targets specified (use -h for help)')
    for (const operand of o.operands) {
      const path = resolve(getcwd(), operand)
      const owner = ownerOf(session, path)
      if (!owner) { err(`error: No package owns ${path}`); code = 1; continue }
      out(`${path} is owned by ${displayName(session, 'pacman', owner.entry)} ${owner.entry.version}`)
    }
    return code
  }
  const pick = operand => {
    const found = translate(session, 'pacman', [operand])
    const name = found.requests[0]?.name ?? operand
    return have.find(({ entry }) => entry.name === name)
  }
  if (o.has('i') || o.has('l')) {
    if (!o.operands.length) return fail('error: no targets specified (use -h for help)')
    let code = 0
    for (const operand of o.operands) {
      const row = pick(operand)
      if (!row) { err(`error: package '${operand}' was not found`); code = 1; continue }
      const manifest = manifestOf(row.scope, row.entry)
      const name = displayName(session, 'pacman', row.entry)
      if (o.has('l')) { for (const path of ownedPaths(row.scope, row.entry)) out(o.has('q') ? path : `${name} ${path}`); continue }
      const requiredBy = row.db.dependentsOf(row.entry.name, row.entry.version).map(other => displayName(session, 'pacman', other))
      out(infoLines([
        ['Name', name], ['Version', row.entry.version], ['Description', descriptionOf(row.scope, row.entry) || 'None'], ['Architecture', 'any'],
        ['URL', manifest.homepage ?? 'None'], ['Licenses', typeof manifest.license === 'string' ? manifest.license : 'None'], ['Groups', 'None'], ['Provides', 'None'],
        ['Depends On', Object.keys(manifest.dependencies ?? {}).map(dependency => displayName(session, 'pacman', { name: dependency })).join('  ') || 'None'],
        ['Optional Deps', 'None'], ['Required By', requiredBy.join('  ') || 'None'], ['Optional For', 'None'], ['Conflicts With', 'None'], ['Replaces', 'None'],
        ['Installed Size', mib(sizeOf(directoryOf(row.scope, row.entry)))], ['Packager', 'Unknown Packager'], ['Build Date', 'None'],
        ['Install Date', row.entry.installed ?? 'None'],
        ['Install Reason', row.entry.explicit ? 'Explicitly installed' : 'Installed as a dependency for another package'], ['Install Script', 'No'],
        ['Validated By', 'None']
      ]) + '\n')
    }
    return code
  }
  if (o.operands.length && !o.has('s')) {
    let code = 0
    for (const operand of o.operands) {
      const row = pick(operand)
      if (!row) { err(`error: package '${operand}' was not found`); code = 1; continue }
      out(lineOf(session, o, row))
    }
    return code
  }
  if (o.has('e')) have = have.filter(({ entry }) => entry.explicit)
  if (o.has('d')) have = have.filter(({ entry }) => !entry.explicit)
  // -t: not required by any other installed package
  if (o.has('t')) have = have.filter(({ entry, db }) => !db.dependentsOf(entry.name, entry.version).length)
  if (o.has('u')) {
    const due = new Map(cachedUpgradable(session.registry, have.map(row => row.entry)).map(entry => [entry.name, cachedVersion(session, entry.name)]))
    have = have.filter(({ entry }) => due.has(entry.name))
    for (const { entry } of have) out(`${displayName(session, 'pacman', entry)} ${entry.version} -> ${due.get(entry.name)}`)
    return 0
  }
  if (o.has('s')) {
    const tests = o.operands.map(term => { try { return new RegExp(term, 'i') } catch { return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } })
    have = have.filter(row => tests.every(test => test.test(displayName(session, 'pacman', row.entry)) || test.test(descriptionOf(row.scope, row.entry))))
    if (!have.length) return 1
    for (const row of have) out(o.has('q') ? displayName(session, 'pacman', row.entry) : `local/${displayName(session, 'pacman', row.entry)} ${row.entry.version}\n    ${descriptionOf(row.scope, row.entry)}`)
    return 0
  }
  if (o.has('m')) return 0
  if (!have.length && (o.has('e') || o.has('d') || o.has('t'))) return 1
  for (const row of have) out(lineOf(session, o, row))
  return 0
}

export async function run(args) {
  try {
    const o = parse(args)
    if (o.operation === 'V') {
      out('\n Pacman v7.0.0 - ecmaOS, on npm\'s registry\n Copyright (C) 2006-2024 Pacman Development Team')
      return 0
    }
    if (o.operation === 'h') { out(usage); return 0 }
    if (!o.operation) { err('error: no operation specified (use -h for help)'); return 1 }
    if ('FDT'.includes(o.operation)) { err(`error: the -${o.operation} operation is not supported on ecmaOS`); return 1 }
    const session = open(o)
    switch (o.operation) {
      case 'S': return await sync(session, o)
      case 'R': return await remove(session, o)
      case 'Q': return await query(session, o)
      case 'U': return await upgradeLocal(session, o)
    }
    return 0
  } catch (error) {
    if (error instanceof Failure) { if (error.message) err(error.message); return error.code }
    err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
