/**
 * ecmaOS's package manager, on npm's registry. `install NAME` installs a package and its dependencies into `/usr/lib`
 * (root) or `~/.local/lib` (anyone else) and links its bins and `share/` files; the other subcommands remove, list,
 * look up, search for and upgrade packages. The engine is `lib/install/`; `uninstall` is `install remove`.
 */

import semver from 'semver'

import { join, resolve } from './lib/path-utils.mjs'
import { Database, keyOf, scopeOf } from './lib/install/db.mjs'
import { Engine, blue, green, parseSpec, pickVersion, red, yellow } from './lib/install/engine.mjs'
import { exists, size } from './lib/install/io.mjs'
import { Registry } from './lib/install/registry.mjs'
import { latestOf as latestAll, rangeOf } from './lib/install/updates.mjs'
import { hasProvenance, verifySignature } from './lib/install/trust.mjs'

const { argv, exit, write, getcwd, geteuid, rmRecursive } = globalThis.ecmaosSyscalls

const usage = `Usage: install [COMMAND] [OPTION]... [PACKAGE]...
Install packages from an npm registry, and manage what is installed.

Commands:
  install PACKAGE...     install packages and their dependencies (the default)
  remove PACKAGE...      remove packages (also: uninstall, rm)
  autoremove             remove dependencies nothing installed by name needs
  list [PATTERN]         list installed packages (also: ls)
  info PACKAGE           show a package's details from the registry (also: show, view)
  search TEXT...         search the registry
  update                 refresh the cached metadata of installed packages
  upgrade [PACKAGE]...   upgrade packages installed by name to their latest versions
  outdated               list packages with newer versions
  clean                  empty the download cache

A PACKAGE is NAME, NAME@VERSION, NAME@RANGE, NAME@TAG, @SCOPE/NAME[@...], or a local .tgz file.

Options:
  --registry URL       registry to use (default: $REGISTRY, else https://registry.npmjs.org)
  -g, --global         install for the whole system (/usr), which needs root
  --user               install for yourself (~/.local), even as root
  --reinstall          install again a version that is already installed
  --offline            use only the cache
  --allow-scripts      run the packages' ecmaos:preinstall and ecmaos:postinstall scripts
  --ignore-signatures  install even when the registry's signature is missing or does not verify
  -n, --dry-run        show what would be done, and do nothing
  --autoremove         with remove, also remove the dependencies no longer needed
  -a, --all            with list and outdated, include dependencies
  --help               display this help and exit

Packages from ecmaOS's own scopes (@ecmaos, @ecmaos-apps) and those listed in /etc/install/allow-scripts run their
scripts without --allow-scripts.`

const COMMANDS = {
  install: 'install', i: 'install', add: 'install',
  remove: 'remove', rm: 'remove', uninstall: 'remove', un: 'remove',
  autoremove: 'autoremove',
  list: 'list', ls: 'list',
  info: 'info', show: 'info', view: 'info',
  search: 'search', find: 'search',
  update: 'update',
  upgrade: 'upgrade', up: 'upgrade',
  outdated: 'outdated',
  clean: 'clean'
}

const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(text + '\n'))
const err = text => write(2, encoder.encode(text + '\n'))

function parse(args) {
  const options = {}
  const operands = []
  let command
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { operands.push(...args.slice(i + 1)); break }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--registry') options.registry = args[++i]
    else if (arg.startsWith('--registry=')) options.registry = arg.slice(11)
    else if (arg === '-g' || arg === '--global') options.global = true
    else if (arg === '--user') options.user = true
    else if (arg === '--reinstall') options.reinstall = true
    else if (arg === '--offline') options.offline = true
    else if (arg === '--allow-scripts') options.allowScripts = true
    else if (arg === '--ignore-signatures') options.ignoreSignatures = true
    else if (arg === '-n' || arg === '--dry-run') options.dryRun = true
    else if (arg === '--autoremove') options.autoremove = true
    else if (arg === '-a' || arg === '--all') options.all = true
    else if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option ${arg}\nTry 'install --help' for more information.`)
    else if (command === undefined && !operands.length && COMMANDS[arg]) command = COMMANDS[arg]
    else operands.push(arg)
  }
  return { command: command ?? 'install', options, operands }
}

function setup(options) {
  if (options.global && geteuid() !== 0) throw new Error('installing for the whole system needs root (sudo install -g ...)')
  const scope = scopeOf(options)
  const db = new Database(scope)
  const registry = new Registry(options.registry, scope.cache, { offline: options.offline })
  return { scope, db, registry, engine: new Engine({ scope, db, registry, options }) }
}

async function install({ options, operands }) {
  if (!operands.length) {
    err(red('Usage: install <package-name>[@version]'))
    return 1
  }
  const { engine } = setup(options)
  const requests = []
  for (const operand of operands) {
    const spec = parseSpec(operand)
    if (!spec) { err(red(`Invalid package name format: ${operand}`)); return 1 }
    if (spec.type === 'file') {
      const path = resolve(getcwd(), spec.path)
      if (!exists(path)) { err(red(`${operand}: no such file`)); return 1 }
      try { requests.push({ name: path, local: await engine.local(path) }) } catch (error) { err(red(error.message)); return 1 }
    } else {
      requests.push({ name: spec.name, range: spec.range })
    }
  }
  return await engine.install(requests)
}

async function list({ options, operands }) {
  const { db, scope } = setup(options)
  const pattern = operands[0]
  const shown = entries => entries.filter(entry => (options.all || entry.explicit) && (!pattern || entry.name.includes(pattern)))
  const rows = shown(db.all()).map(entry => [entry, ''])
  // a user's own packages, and the system's beside them unless --user asked for only the user's
  if (!scope.system && !options.user) rows.push(...shown(new Database(scopeOf({ global: true })).all()).map(entry => [entry, ' [system]']))
  for (const [entry, where] of rows) out(`${keyOf(entry.name, entry.version)}${entry.explicit ? '' : ' [dependency]'}${where}`)
  if (!rows.length && pattern) return 1
  return 0
}

async function info({ options, operands }) {
  const spec = operands[0] && parseSpec(operands[0])
  if (spec?.type !== 'registry') { err(red('Usage: install info <package-name>[@version]')); return 1 }
  const { db, registry } = setup(options)
  const document = await registry.document(spec.name)
  const version = pickVersion(document, spec.range)
  const manifest = document.versions?.[version]
  if (!manifest) { err(red(`No version of ${spec.name} matches ${spec.range ?? 'latest'}`)); return 1 }
  const dependencies = Object.entries(manifest.dependencies ?? {})
  const lines = [
    '',
    `${blue(`${document.name}@${version}`)} | ${manifest.license ?? document.license ?? 'no license'} | deps: ${dependencies.length || 'none'} | versions: ${Object.keys(document.versions).length}`,
    manifest.description ?? document.description ?? '',
    manifest.homepage ?? document.homepage ?? ''
  ].filter((line, index) => index < 2 || line)
  if (manifest.deprecated) lines.push(red(`DEPRECATED: ${manifest.deprecated}`))
  const bins = typeof manifest.bin === 'string' ? [String(document.name).split('/').pop()] : Object.keys(manifest.bin ?? {})
  if (bins.length) lines.push('', `bin: ${bins.join(', ')}`)
  const dist = manifest.dist ?? {}
  lines.push('', 'dist', `.tarball: ${dist.tarball ?? ''}`, `.shasum: ${dist.shasum ?? ''}`)
  if (dist.integrity) lines.push(`.integrity: ${dist.integrity}`)
  if (dist.unpackedSize) lines.push(`.unpackedSize: ${size(dist.unpackedSize)}`)
  const signature = await verifySignature(registry.url, document.name, version, dist)
  lines.push(`.signature: ${signature ? red(signature) : (dist.signatures?.length ? green('verified') : 'none (the registry does not sign)')}`)
  lines.push(`.provenance: ${hasProvenance(dist) ? green('yes') : 'no'}`)
  if (dependencies.length) lines.push('', 'dependencies:', ...dependencies.map(([name, range]) => `${name}: ${range}`))
  lines.push('', 'dist-tags:', ...Object.entries(document['dist-tags'] ?? {}).map(([tag, value]) => `${tag}: ${value}`))
  const maintainers = (document.maintainers ?? []).map(person => (typeof person === 'string' ? person : person.name)).filter(Boolean)
  if (maintainers.length) lines.push('', 'maintainers:', ...maintainers.map(name => `- ${name}`))
  if (document.time?.[version]) lines.push('', `published ${document.time[version]}`)
  const installed = db.versionsOf(document.name)
  lines.push('', `installed: ${installed.length ? installed.map(entry => `${entry.version}${entry.explicit ? '' : ' (dependency)'}`).join(', ') : 'no'}`, '')
  out(lines.join('\n'))
  return 0
}

async function search({ options, operands }) {
  if (!operands.length) { err(red('Usage: install search <text>')); return 1 }
  const { db, registry } = setup(options)
  const found = await registry.search(operands.join(' '))
  if (!found.length) { out(`No packages match ${operands.join(' ')}`); return 1 }
  const width = Math.max(...found.map(item => item.name.length))
  for (const item of found) {
    const installed = db.versionsOf(item.name).length ? ' [installed]' : ''
    const description = String(item.description ?? '').replace(/\s+/g, ' ')
    out(`${green(item.name.padEnd(width))}  ${item.version}${installed}\n  ${description.length > 76 ? description.slice(0, 75) + '…' : description}`)
  }
  return 0
}

/** `latestOf`, with the failures on stderr */
const latestOf = (db, registry, entries) => latestAll(registry, entries, failure => err(yellow(failure)))

async function update({ options }) {
  const { db, registry } = setup(options)
  const entries = db.all()
  const latest = await latestOf(db, registry, entries)
  const fetched = Object.keys(latest).length
  out(`Refreshed the metadata of ${fetched} package${fetched === 1 ? '' : 's'} from ${registry.url}`)
  const upgradable = db.explicit().filter(entry => latest[entry.name]?.latest && semver.gt(latest[entry.name].latest, entry.version))
  if (upgradable.length) out(`${upgradable.length} package${upgradable.length === 1 ? ' can' : 's can'} be upgraded. Run 'install outdated' to see ${upgradable.length === 1 ? 'it' : 'them'}.`)
  else out('All packages are up to date.')
  return 0
}

async function outdated({ options }) {
  const { db, registry } = setup(options)
  const entries = options.all ? db.all() : db.explicit()
  const latest = await latestOf(db, registry, entries)
  const rows = []
  for (const entry of entries) {
    const newest = latest[entry.name]?.latest
    if (!newest || !semver.gt(newest, entry.version)) continue
    // a dependency can move only as far as every package that depends on it allows
    let wanted = newest
    if (!entry.explicit) {
      const ranges = db.dependentsOf(entry.name, entry.version).map(other => rangeOf(db, other, entry.name)).filter(Boolean)
      wanted = semver.maxSatisfying(Object.keys(latest[entry.name].document.versions), ranges.join(' ') || '*') ?? entry.version
    }
    rows.push([entry.name, entry.version, wanted, newest, entry.explicit ? '' : 'dependency'])
  }
  if (!rows.length) return 0
  const table = [['Package', 'Current', 'Wanted', 'Latest', ''], ...rows]
  const widths = table[0].map((_, column) => Math.max(...table.map(row => row[column].length)))
  for (const row of table) out(row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd())
  return 1
}

async function upgrade({ options, operands }) {
  const { db, registry, engine } = setup(options)
  const named = operands.map(parseSpec)
  if (named.some(spec => spec?.type !== 'registry')) { err(red('Usage: install upgrade [package-name]...')); return 1 }
  const entries = named.length
    ? named.map(spec => db.versionsOf(spec.name).find(entry => entry.explicit) ?? db.versionsOf(spec.name)[0]).filter(Boolean)
    : db.explicit()
  for (const spec of named) if (!db.versionsOf(spec.name).length) { err(red(`Package ${spec.name} is not installed`)); return 1 }
  const latest = await latestOf(db, registry, entries)
  const requests = entries
    .filter(entry => latest[entry.name]?.latest && semver.gt(latest[entry.name].latest, entry.version))
    .map(entry => ({ name: entry.name, range: latest[entry.name].latest }))
  if (!requests.length) { out('All packages are up to date.'); return 0 }
  return await engine.install(requests)
}

async function main() {
  const parsed = parse(argv.slice(1))
  if (parsed.options.help) {
    err(usage)
    return 0
  }
  switch (parsed.command) {
    case 'install': return await install(parsed)
    case 'remove': {
      if (!parsed.operands.length) { err(red('Usage: install remove <package-name>[@version]...')); return 1 }
      const { engine } = setup(parsed.options)
      return await engine.remove(parsed.operands, { autoremove: parsed.options.autoremove })
    }
    case 'autoremove': {
      const { engine, db } = setup(parsed.options)
      const ok = engine.autoremove()
      db.save()
      return ok ? 0 : 1
    }
    case 'list': return await list(parsed)
    case 'info': return await info(parsed)
    case 'search': return await search(parsed)
    case 'update': return await update(parsed)
    case 'upgrade': return await upgrade(parsed)
    case 'outdated': return await outdated(parsed)
    case 'clean': {
      const { scope } = setup(parsed.options)
      for (const directory of ['tarballs', 'meta']) try { rmRecursive(join(scope.cache, directory)) } catch { /* empty already */ }
      out(`Emptied ${scope.cache}`)
      return 0
    }
  }
  return 1
}

try {
  exit(await main())
} catch (error) {
  err(`install: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
