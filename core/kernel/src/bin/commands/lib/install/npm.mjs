/**
 * `npm`, `npx`, `yarn` and `pnpm` over `install`'s engine. In a project, packages go into `node_modules` (the ones asked
 * for by name linked at the top, the rest in `node_modules/.ecmaos` beside their own `node_modules`, as pnpm lays them
 * out) and `package.json` is kept up to date; with `-g`, they go where `install` puts them (`/usr` for root, `~/.local`
 * for anyone else). Output follows each tool's own.
 */

import semver from 'semver'

import { join, resolve } from '../path-utils.mjs'
import { parseSpec, pickVersion } from './engine.mjs'
import { exists, mkdirp, readText, writeAtomic } from './io.mjs'
import { latestOf } from './updates.mjs'
import { Failure, confirm, err, openSession, out } from './frontend.mjs'

const { env, getcwd, custom, rmRecursive } = globalThis.ecmaosSyscalls

const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies']

const VERBS = {
  npm: {
    install: 'install', i: 'install', add: 'install', in: 'install', ins: 'install', inst: 'install', insta: 'install', instal: 'install',
    ci: 'ci', 'clean-install': 'ci', 'install-clean': 'ci',
    uninstall: 'remove', un: 'remove', unlink: 'remove', remove: 'remove', rm: 'remove', r: 'remove',
    update: 'update', up: 'update', upgrade: 'update',
    ls: 'list', list: 'list', ll: 'list', la: 'list',
    outdated: 'outdated', prune: 'prune', dedupe: 'noop', ddp: 'noop', rebuild: 'noop', fund: 'noop',
    run: 'run', 'run-script': 'run', rum: 'run', urn: 'run', test: 'script:test', t: 'script:test', tst: 'script:test', start: 'script:start', stop: 'script:stop', restart: 'script:restart',
    exec: 'exec', x: 'exec', init: 'init', create: 'create',
    view: 'view', info: 'view', show: 'view', v: 'view', search: 'search', find: 'search', s: 'search', se: 'search',
    config: 'config', c: 'config', cache: 'cache', root: 'root', prefix: 'prefix', bin: 'bin', version: 'version', help: 'help'
  },
  yarn: {
    install: 'install', add: 'add', remove: 'remove', upgrade: 'update', up: 'update', list: 'list', ls: 'list', outdated: 'outdated', run: 'run', init: 'init',
    info: 'view', view: 'view', dlx: 'dlx', exec: 'exec', cache: 'cache', config: 'config', global: 'global', bin: 'bin', help: 'help', why: 'why', autoclean: 'noop', check: 'noop'
  },
  pnpm: {
    install: 'install', i: 'install', add: 'add', remove: 'remove', rm: 'remove', uninstall: 'remove', un: 'remove', update: 'update', up: 'update', upgrade: 'update',
    list: 'list', ls: 'list', outdated: 'outdated', run: 'run', 'run-script': 'run', exec: 'exec', dlx: 'dlx', init: 'init', view: 'view', info: 'view', show: 'view', v: 'view',
    search: 'search', find: 'search', config: 'config', root: 'root', bin: 'bin', prune: 'prune', dedupe: 'noop', test: 'script:test', t: 'script:test', start: 'script:start', stop: 'script:stop', restart: 'script:restart', store: 'cache', help: 'help'
  }
}
// the scripts a package.json names that a tool runs by their bare name
const SCRIPT_SHORTCUTS = { yarn: true, pnpm: false, npm: false }

const NOT_AVAILABLE = new Set(['publish', 'login', 'logout', 'adduser', 'whoami', 'token', 'owner', 'access', 'team', 'hook', 'org', 'profile', 'audit', 'pack', 'link', 'ln', 'unpublish', 'deprecate', 'dist-tag', 'diff', 'doctor', 'explain', 'why', 'completion', 'docs', 'home', 'bugs', 'repo', 'edit', 'explore', 'pkg', 'set-script', 'shrinkwrap', 'star', 'stars', 'unstar', 'sbom', 'query', 'ping', 'xmas', 'publish'])

const usages = {
  npm: `Usage: npm <command>

  install [<package>...]   add packages to the project (-g: for the whole system, or you)
  uninstall <package>...   remove them
  update [<package>...]    upgrade within the ranges package.json allows
  ls, outdated, run <script>, test, start, exec, init, view <package>, search <text>, config get <key>, cache clean, root, prefix

Options: -g, -D/--save-dev, -E/--save-exact, -O/--save-optional, --no-save, --registry=URL, --offline, --prefix DIR, -y/--yes`,
  yarn: `Usage: yarn [command] [flags]

  install, add <package>..., remove <package>..., upgrade, list, outdated, run <script>, init, info <package>, dlx <package>, global add|remove|list`,
  pnpm: `Usage: pnpm [command] [options]

  install, add <package>..., remove <package>..., update, list, outdated, run <script>, exec, dlx <package>, init, view <package>, search <text>, root`
}

const VERSIONS = { npm: '10.9.2', npx: '10.9.2', yarn: '1.22.22', pnpm: '10.28.2' }

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

function elapsed(start) {
  const ms = Date.now() - start
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}

// Parsing

function parse(tool, args) {
  const o = { rest: [], positional: [] }
  const flags = {
    '-g': 'global', '--global': 'global', '--location=global': 'global', '-D': 'dev', '--save-dev': 'dev', '--dev': 'dev', '-E': 'exact', '--save-exact': 'exact', '--exact': 'exact',
    '-O': 'optional', '--save-optional': 'optional', '--optional': 'optional', '-P': 'prod', '--save-prod': 'prod', '--no-save': 'noSave', '-y': 'yes', '--yes': 'yes',
    '--offline': 'offline', '--user': 'user', '--production': 'production', '--omit=dev': 'production', '--only=prod': 'production', '--only=production': 'production',
    '--all': 'all', '-a': 'all', '--long': 'long', '--json': 'json', '--silent': 'silent', '-s': 'silent', '--quiet': 'silent', '-q': 'silent', '--ignore-signatures': 'ignoreSignatures',
    '--allow-scripts': 'allowScripts', '--dry-run': 'dryRun', '--force': 'force', '-f': 'force', '--ignore-workspace-root-check': 'ignore', '-w': 'ignore'
  }
  const ignored = new Set(['--legacy-peer-deps', '--no-audit', '--no-fund', '--audit=false', '--fund=false', '--ignore-scripts', '--prefer-offline', '--no-progress', '--frozen-lockfile', '--no-lockfile', '--package-lock-only', '--no-package-lock', '--non-interactive', '--no-bin-links', '--strict-peer-deps', '--verbose', '--loglevel', '--no-color', '--color', '--ignore-engines', '--ignore-platform', '--update-notifier=false', '--no-update-notifier', '--progress=false', '--prefer-online'])
  const withValue = new Set(['--registry', '--prefix', '--cwd', '--loglevel', '--tag', '--depth', '--workspace', '--package', '-p', '--call', '-c', '--userconfig', '--cache'])
  let verb
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { o.rest.push(...args.slice(i + 1)); break }
    // the script or command is named: the rest is its own (npm alone wants `--` for a script's arguments)
    if (verb !== undefined && o.positional.length >= 1) {
      const op = VERBS[tool][verb] ?? (tool === 'yarn' ? 'run' : undefined)
      if (op === 'exec' || op === 'dlx' || (op === 'run' && tool !== 'npm')) { o.rest.push(...args.slice(i)); break }
    }
    if (verb !== undefined && o.positional.length === 0 && tool !== 'npm' && String(VERBS[tool][verb] ?? '').startsWith('script:')) { o.rest.push(...args.slice(i)); break }
    if (verb !== undefined && o.positional.length === 0 && tool === 'yarn' && VERBS.yarn[verb] === undefined && !NOT_AVAILABLE.has(verb)) { o.rest.push(...args.slice(i)); break }
    if (arg === '-v' || arg === '--version') { o.version = true; continue }
    if (arg === '-h' || arg === '--help') { o.help = true; continue }
    if (arg.startsWith('--registry=')) { o.registry = arg.slice(11); continue }
    if (arg === '--registry') { o.registry = args[++i]; continue }
    if (arg.startsWith('--prefix=') || arg.startsWith('--cwd=')) { o.prefix = arg.slice(arg.indexOf('=') + 1); continue }
    if (arg === '--prefix' || arg === '--cwd' || arg === '-C') { o.prefix = args[++i]; continue }
    if (arg.startsWith('--depth=')) { o.depth = Number(arg.slice(8)); continue }
    if (arg === '--depth') { o.depth = Number(args[++i]); continue }
    if (arg === '--package' || arg === '-p') { (o.packages ??= []).push(args[++i]); continue }
    if (arg.startsWith('--package=')) { (o.packages ??= []).push(arg.slice(10)); continue }
    if (flags[arg]) { o[flags[arg]] = true; continue }
    if (ignored.has(arg) || /^--(loglevel|cache|userconfig|tag|workspace)=/.test(arg)) continue
    if (withValue.has(arg)) { i++; continue }
    if (/^-[gDEOPsqyaf]{2,}$/.test(arg)) { for (const letter of arg.slice(1)) o[flags[`-${letter}`]] = true; continue }
    if (arg.startsWith('-') && arg.length > 1 && !verb) { o.unknown = arg; continue }
    if (arg.startsWith('-') && arg.length > 1) { o.unknown = arg; continue }
    if (verb === undefined) verb = arg
    else o.positional.push(arg)
  }
  o.verb = verb
  return o
}

// package.json

function findProject(start) {
  for (let dir = start; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    if (exists(join(dir, 'package.json')) || exists(join(dir, 'node_modules'))) return dir
    if (dir === '/') return start
  }
}

function readManifest(dir, { required = false } = {}) {
  const path = join(dir, 'package.json')
  if (!exists(path)) {
    if (required) throw new Failure(`npm error code ENOENT\nnpm error syscall open\nnpm error path ${path}\nnpm error errno -2\nnpm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${path}'`, 254)
    return { data: {}, indent: 2, exists: false }
  }
  const text = readText(path)
  try {
    return { data: JSON.parse(text), indent: /^([ \t]+)"/m.exec(text)?.[1] ?? 2, exists: true }
  } catch (error) {
    throw new Failure(`npm error code EJSONPARSE\nnpm error JSON.parse Invalid package.json: ${error.message}\nnpm error path ${path}`, 1)
  }
}

function writeManifest(dir, manifest) {
  const data = { ...manifest.data }
  for (const group of GROUPS) if (data[group]) data[group] = Object.fromEntries(Object.entries(data[group]).sort(([a], [b]) => a.localeCompare(b)))
  writeAtomic(join(dir, 'package.json'), JSON.stringify(data, null, manifest.indent) + '\n')
}

const dependenciesOf = (data, { production = false } = {}) => ({
  ...(production ? {} : data.devDependencies),
  ...data.optionalDependencies,
  ...data.dependencies
})

// Sessions

function context(tool, o) {
  const cwd = o.prefix ? resolve(getcwd(), o.prefix) : getcwd()
  if (o.global) {
    return { tool, o, cwd, global: true, session: openSession(o) }
  }
  const dir = o.prefix ? cwd : findProject(cwd)
  const session = openSession({ ...o, project: dir })
  return { tool, o, cwd, dir, global: false, session }
}

function toRequests(context, operands) {
  const requests = []
  for (const operand of operands) {
    const spec = parseSpec(operand)
    if (!spec) throw new Failure(`npm error code EINVALIDTAGNAME\nnpm error Invalid package name "${operand}"`, 1)
    if (spec.type === 'file') {
      const path = resolve(context.cwd, spec.path)
      if (!exists(path)) throw new Failure(`npm error code ENOENT\nnpm error enoent ${operand}: no such file`, 1)
      requests.push({ name: path, file: path })
    } else {
      requests.push({ name: spec.name, range: spec.range, asked: operand })
    }
  }
  return requests
}

/** Resolves and installs `requests`; gives `{ code, plan, changes }` with the explicit nodes of the plan */
async function carryOut(context, requests) {
  const { engine } = context.session
  const prepared = []
  for (const request of requests) {
    if (request.file) { const local = await engine.local(request.file); prepared.push({ name: request.file, local, package: local.name, asked: local.name }) }
    else prepared.push(request)
  }
  let plan
  try {
    plan = await engine.resolve(prepared)
  } catch (error) {
    engine.discard(prepared)
    throw new Failure(`npm error code E404\nnpm error ${error instanceof Error ? error.message : String(error)}`, 1)
  }
  const changes = engine.changes(plan)
  if (context.o.dryRun) return { code: 0, plan, changes, requests: prepared }
  const code = await engine.apply(plan)
  return { code, plan, changes, requests: prepared }
}

const nameOf = request => request.package ?? request.name

/** What version of `name` a plan installed for the request (the highest of its explicit nodes) */
const versionIn = (plan, name) => [...plan.values()].filter(node => node.name === name && node.explicit).map(node => node.version).sort(semver.rcompare)[0]

/** Makes the project's explicit packages exactly `wanted` (names): the rest become dependencies and go if nothing needs them */
function syncExplicit(context, wanted) {
  const { db, engine } = context.session
  for (const entry of db.explicit()) {
    if (wanted.has(entry.name)) continue
    engine.unlinkEntry(entry)
    entry.explicit = false
    db.set(entry)
  }
  const before = db.all().length
  engine.autoremove(true)
  db.save()
  return before - db.all().length
}

// Reports

function reportInstall(context, { added, changed, removed, direct, start, kind }) {
  const { tool, o } = context
  if (o.silent) return
  if (tool === 'yarn') {
    out(`[1/4] Resolving packages...\n[2/4] Fetching packages...\n[3/4] Linking dependencies...\n[4/4] Building fresh packages...`)
    if (kind === 'add') out(`success Saved ${plural(direct.length, 'new dependency').replace('dependencys', 'dependencies')}.`)
    else out('success Already up-to-date.')
    if (direct.length) out(`info Direct dependencies\n${direct.map((item, index) => `${index === direct.length - 1 ? '└─' : '├─'} ${item.name}@${item.version}`).join('\n')}`)
    out(`Done in ${(Math.max(1, Date.now() - start) / 1000).toFixed(2)}s.`)
  } else if (tool === 'pnpm') {
    if (added) out(`Packages: +${added}\n${'+'.repeat(Math.min(added, 40))}\nProgress: resolved ${added}, reused 0, downloaded ${added}, added ${added}, done`)
    if (direct.length) out(`\n${direct.some(item => item.dev) ? 'devDependencies' : 'dependencies'}:\n${direct.map(item => `+ ${item.name} ${item.version}`).join('\n')}`)
    out(`\nDone in ${elapsed(start)}`)
  } else {
    const parts = []
    if (added) parts.push(`added ${plural(added, 'package')}`)
    if (removed) parts.push(`removed ${plural(removed, 'package')}`)
    if (changed) parts.push(`changed ${plural(changed, 'package')}`)
    out(`\n${parts.length ? parts.join(', ') : 'up to date'} in ${elapsed(start)}`)
  }
}

function summarize(context, result) {
  const { changes } = result
  return { added: changes.added.length, changed: changes.upgraded.length + changes.reinstalled.length }
}

// Operations

async function add(context, operands, { kind = 'add' } = {}) {
  const { o, global } = context
  const start = Date.now()
  if (!operands.length) throw new Failure('npm error Usage: npm install <package>...', 1)
  const requests = toRequests(context, operands)
  const result = await carryOut(context, requests)
  if (result.code) return result.code
  const direct = result.requests.map(request => ({ name: nameOf(request), version: versionIn(result.plan, nameOf(request)), dev: o.dev })).filter(item => item.version)
  if (!global && !o.noSave && !o.dryRun) {
    const manifest = readManifest(context.dir)
    const group = o.dev ? 'devDependencies' : o.optional ? 'optionalDependencies' : 'dependencies'
    for (const item of direct) {
      const request = result.requests.find(candidate => nameOf(candidate) === item.name)
      const typed = request.range && !/^(latest|next|beta|alpha|canary|rc|[a-z][a-z-]*)$/.test(request.range) ? request.range : undefined
      for (const other of GROUPS) if (other !== group && manifest.data[other]) delete manifest.data[other][item.name]
      manifest.data[group] ??= {}
      // a dependency listed in `dependencies` stays there when `--save-dev` is not asked for, as npm keeps it
      if (!o.dev && !o.optional && !o.prod && manifest.data.devDependencies?.[item.name] !== undefined) { manifest.data.devDependencies[item.name] = typed ?? (o.exact ? item.version : `^${item.version}`); continue }
      manifest.data[group][item.name] = typed ?? (o.exact ? item.version : `^${item.version}`)
    }
    writeManifest(context.dir, manifest)
  }
  if (o.dryRun) { out(`${plural(result.changes.fresh.length, 'package')} would be added`); return 0 }
  reportInstall(context, { ...summarize(context, result), direct, start, kind })
  return 0
}

async function installAll(context, { clean = false } = {}) {
  const { o, global } = context
  const start = Date.now()
  if (global) throw new Failure('npm error Usage: npm install -g <package>...', 1)
  const manifest = readManifest(context.dir, { required: context.tool === 'npm' && clean })
  const wanted = dependenciesOf(manifest.data, { production: o.production })
  if (clean) {
    try { rmRecursive(join(context.dir, 'node_modules')) } catch { /* none yet */ }
    context.session = openSession({ ...o, project: context.dir })
  }
  const requests = Object.entries(wanted).map(([name, range]) => ({ name, range: range === '*' ? undefined : range, asked: name }))
  const direct = []
  let result = { changes: { added: [], upgraded: [], reinstalled: [] }, plan: new Map(), requests: [] }
  if (requests.length) {
    result = await carryOut(context, requests)
    if (result.code) return result.code
    for (const request of requests) { const version = versionIn(result.plan, request.name); if (version) direct.push({ name: request.name, version, dev: Boolean(manifest.data.devDependencies?.[request.name]) }) }
  }
  const removed = context.session.db.explicit().some(entry => !(entry.name in wanted)) ? syncExplicit(context, new Set(Object.keys(wanted))) : 0
  reportInstall(context, { ...summarize(context, result), removed, direct: [], start, kind: 'install' })
  return 0
}

async function remove(context, operands) {
  const { o, global } = context
  const start = Date.now()
  if (!operands.length) throw new Failure('npm error Usage: npm uninstall <package>...', 1)
  const names = operands.map(operand => parseSpec(operand)?.name ?? operand)
  const { engine, db } = context.session
  const before = db.all().length
  const present = names.filter(name => db.versionsOf(name).length)
  if (present.length) {
    const code = await engine.remove(present, { autoremove: true })
    if (code) return code
  }
  if (!global && !o.noSave) {
    const manifest = readManifest(context.dir)
    let changed = false
    for (const group of [...GROUPS, 'peerDependencies']) for (const name of names) if (manifest.data[group] && name in manifest.data[group]) { delete manifest.data[group][name]; changed = true }
    if (changed) writeManifest(context.dir, manifest)
  }
  if (!o.silent) {
    const removed = before - db.all().length
    if (context.tool === 'yarn') out(`[1/2] Removing module ${names.join(', ')}...\n[2/2] Regenerating lockfile and installing missing dependencies...\nsuccess Uninstalled packages.\nDone in ${(Math.max(1, Date.now() - start) / 1000).toFixed(2)}s.`)
    else if (context.tool === 'pnpm') out(`Packages: -${removed}\n${'-'.repeat(Math.min(removed, 40))}\n\ndependencies:\n${names.map(name => `- ${name}`).join('\n')}\n\nDone in ${elapsed(start)}`)
    else out(`\n${removed ? `removed ${plural(removed, 'package')}` : 'up to date'} in ${elapsed(start)}`)
  }
  return 0
}

async function update(context, operands) {
  const { o, global } = context
  const start = Date.now()
  const { db, registry } = context.session
  const manifest = global ? undefined : readManifest(context.dir)
  const declared = global ? {} : dependenciesOf(manifest.data)
  let entries = db.explicit()
  if (operands.length) entries = entries.filter(entry => operands.includes(entry.name))
  const latest = await latestOf(registry, entries, message => err(`npm warn ${message}`))
  const requests = []
  for (const entry of entries) {
    const document = latest[entry.name]?.document
    if (!document) continue
    const range = global ? undefined : declared[entry.name]
    const wanted = range && !/^(latest|next)$/.test(range) ? semver.maxSatisfying(Object.keys(document.versions), range) : latest[entry.name].latest
    if (wanted && semver.gt(wanted, entry.version)) requests.push({ name: entry.name, range: wanted, asked: entry.name })
  }
  if (!requests.length) { if (!o.silent) reportInstall(context, { added: 0, changed: 0, removed: 0, direct: [], start, kind: 'update' }); return 0 }
  const result = await carryOut(context, requests)
  if (result.code) return result.code
  if (!global && !o.noSave) {
    for (const request of requests) {
      const group = GROUPS.find(name => manifest.data[name]?.[request.name] !== undefined)
      if (!group) continue
      const old = manifest.data[group][request.name]
      const prefix = /^[\^~]/.exec(old)?.[0]
      if (prefix) manifest.data[group][request.name] = `${prefix}${versionIn(result.plan, request.name)}`
    }
    writeManifest(context.dir, manifest)
  }
  reportInstall(context, { ...summarize(context, result), direct: [], start, kind: 'update' })
  return 0
}

async function outdated(context, operands) {
  const { global } = context
  const { db, registry } = context.session
  const manifest = global ? undefined : readManifest(context.dir)
  const declared = global ? {} : dependenciesOf(manifest.data)
  const entries = db.explicit().filter(entry => !operands.length || operands.includes(entry.name))
  const latest = await latestOf(registry, entries, message => err(`npm warn ${message}`))
  const rows = []
  for (const entry of entries) {
    const document = latest[entry.name]?.document
    if (!document) continue
    const newest = latest[entry.name].latest
    const range = declared[entry.name]
    const wanted = range && !/^(latest|next)$/.test(range) ? (semver.maxSatisfying(Object.keys(document.versions), range) ?? entry.version) : newest
    if (semver.eq(entry.version, newest) && semver.eq(entry.version, wanted)) continue
    rows.push([entry.name, entry.version, wanted, newest, entry.name])
  }
  if (!rows.length) return 0
  if (context.o.json) {
    out(JSON.stringify(Object.fromEntries(rows.map(([name, current, wanted, newest]) => [name, { current, wanted, latest: newest, location: join(context.dir ?? '', 'node_modules', name) }])), null, 2))
    return 1
  }
  const table = [['Package', 'Current', 'Wanted', 'Latest', 'Location'], ...rows.map(row => [...row.slice(0, 4), `node_modules/${row[4]}`])]
  const widths = table[0].map((_, column) => Math.max(...table.map(row => row[column].length)))
  for (const row of table) out(row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd())
  return 1
}

function list(context, operands) {
  const { o, global } = context
  const { db } = context.session
  const manifest = global ? { data: { name: 'lib', version: '', } } : readManifest(context.dir)
  const root = global ? context.session.scope.lib : context.dir
  const declared = global ? undefined : dependenciesOf(manifest.data, { production: o.production })
  const top = db.explicit().filter(entry => (!declared || entry.name in declared) && (!operands.length || operands.includes(entry.name)))
  const depth = o.all ? Infinity : (o.depth ?? Infinity)
  if (o.json) {
    const tree = entry => ({ version: entry.version, ...(Object.keys(entry.dependencies ?? {}).length ? { dependencies: Object.fromEntries(Object.entries(entry.dependencies).map(([name, version]) => [name, tree(db.get(name, version) ?? { version })])) } : {}) })
    out(JSON.stringify({ name: manifest.data.name, ...(manifest.data.version ? { version: manifest.data.version } : {}), dependencies: Object.fromEntries(top.map(entry => [entry.name, tree(entry)])) }, null, 2))
    return 0
  }
  const lines = [`${manifest.data.name ? `${manifest.data.name}@${manifest.data.version ?? ''}`.replace(/@$/, '') : ''} ${root}`.trim()]
  const walk = (entry, prefix, level, seen) => {
    const children = Object.entries(entry.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))
    children.forEach(([name, version], index) => {
      const last = index === children.length - 1
      const child = db.get(name, version)
      lines.push(`${prefix}${last ? '└── ' : '├── '}${name}@${version}${seen.includes(`${name}@${version}`) ? ' deduped' : ''}`)
      if (child && level < depth && !seen.includes(`${name}@${version}`)) walk(child, `${prefix}${last ? '    ' : '│   '}`, level + 1, [...seen, `${name}@${version}`])
    })
  }
  top.forEach((entry, index) => {
    const last = index === top.length - 1
    lines.push(`${last ? '└── ' : '├── '}${entry.name}@${entry.version}`)
    if (depth > 0) walk(entry, last ? '    ' : '│   ', 1, [`${entry.name}@${entry.version}`])
  })
  if (!top.length) lines.push('└── (empty)')
  out(lines.join('\n'))
  return 0
}

// Scripts

/** Runs `command` with `sh -c` in `cwd`, `PATH` leading with the project's `.bin`; gives the exit status */
async function shell(command, cwd, extra = {}) {
  const dirs = []
  for (let dir = cwd; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    dirs.push(join(dir, 'node_modules/.bin'))
    if (dir === '/') break
  }
  const environment = { ...env, ...extra, PATH: `${dirs.filter(exists).join(':')}${dirs.some(exists) ? ':' : ''}${env['PATH'] ?? ''}` }
  const pid = await custom('proc_spawn', '/bin/sh', JSON.stringify(['sh', '-c', command]), cwd, JSON.stringify({ env: environment }))
  return await custom('proc_wait', pid)
}

const quote = word => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)

async function runScript(context, name, rest) {
  const { tool, o } = context
  const manifest = readManifest(context.dir ?? context.cwd, { required: true })
  const scripts = manifest.data.scripts ?? {}
  const dir = context.dir ?? context.cwd
  if (!name) {
    const names = Object.keys(scripts)
    if (tool === 'npm') {
      out(`Scripts available in ${manifest.data.name}@${manifest.data.version} via \`npm run-script\`:\n${names.map(script => `  ${script}\n    ${scripts[script]}`).join('\n')}`)
    } else {
      out(`${tool === 'yarn' ? 'info Commands available from binaries:' : 'Commands available via "pnpm run":'}\n${names.map(script => `  ${script}\n    ${scripts[script]}`).join('\n')}`)
    }
    return 0
  }
  if (!(name in scripts)) {
    if (tool === 'npm') err(`npm error Missing script: "${name}"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run`)
    else if (tool === 'yarn') err(`error Command "${name}" not found.`)
    else err(` ERR_PNPM_NO_SCRIPT  Missing script: ${name}`)
    return 1
  }
  const extra = { npm_lifecycle_event: name, npm_package_name: manifest.data.name ?? '', npm_package_version: manifest.data.version ?? '', npm_config_user_agent: `${tool}/${VERSIONS[tool]} node ecmaos`, INIT_CWD: context.cwd, npm_execpath: `/bin/${tool}`, npm_node_execpath: '/bin/node' }
  for (const phase of [`pre${name}`, name, `post${name}`]) {
    const command = scripts[phase]
    if (!command) continue
    const line = phase === name && rest.length ? `${command} ${rest.map(quote).join(' ')}` : command
    if (!o.silent) out(tool === 'yarn' ? `$ ${line}` : `\n> ${manifest.data.name ?? ''}${manifest.data.version ? `@${manifest.data.version}` : ''} ${phase}\n> ${line}\n`)
    const code = await shell(line, dir, extra)
    if (code) {
      if (tool === 'npm') err(`npm error Lifecycle script \`${phase}\` failed with error:\nnpm error code ${code}`)
      else if (tool === 'yarn') err(`error Command failed with exit code ${code}.`)
      else err(` ELIFECYCLE  Command failed with exit code ${code}.`)
      return code
    }
  }
  return 0
}

/** `npx`, `npm exec`, `yarn dlx`, `pnpm dlx`: runs a package's command, fetching the package first if it is not at hand */
async function exec(context, args) {
  const { o, tool } = context
  const packages = o.packages ?? []
  let command = args[0]
  const rest = args.slice(1)
  if (!packages.length && !command) throw new Failure(`${tool === 'npx' ? 'npx' : 'npm'} error Usage: npx <package> [args...]`, 1)
  const wanted = packages.length ? packages : [command]
  const specs = wanted.map(parseSpec)
  if (specs.some(spec => spec?.type !== 'registry')) throw new Failure('npm error code EINVALIDTAGNAME\nnpm error Invalid package name', 1)
  const primary = specs[0]
  const base = command && !packages.length ? primary.name.split('/').pop() : command ?? primary.name.split('/').pop()
  if (!packages.length) command = base
  // a command the project (or an ancestor) has is run as it is, unless a version was asked for
  if (!specs.some(spec => spec.range)) {
    for (let dir = context.cwd; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
      const bin = join(dir, 'node_modules/.bin', command)
      if (exists(bin)) return await spawnProgram(bin, command, rest, context)
      if (dir === '/') break
    }
  }
  // else from the cache of fetched packages (a project of its own), installed on the first use
  const key = wanted.join('+').replace(/[^\w@.+-]/g, '_')
  const root = join(openSession({ ...o }).scope.cache, 'exec', key)
  mkdirp(root)
  const session = openSession({ ...o, project: root })
  const requests = specs.map(spec => ({ name: spec.name, range: spec.range, asked: spec.name }))
  const settled = requests.every(request => session.db.versionsOf(request.name).length && !request.range)
  if (!settled) {
    let plan
    try { plan = await session.engine.resolve(requests) } catch (error) { throw new Failure(`npm error code E404\nnpm error ${error instanceof Error ? error.message : String(error)}`, 1) }
    const fresh = session.engine.changes(plan).fresh
    if (fresh.length) {
      if (!o.yes && !o.silent) {
        err(`Need to install the following packages:\n${specs.map(spec => `${spec.name}@${versionIn(plan, spec.name)}`).join('\n')}`)
        if (!confirm('Ok to proceed? (y)')) { err('npm error canceled'); return 1 }
      }
      const code = await session.engine.apply(plan)
      if (code) return code
    }
  }
  const bin = join(root, 'node_modules/.bin', command)
  if (!exists(bin)) {
    // a package whose only bin has another name than the package's
    const names = (() => { try { return session.db.versionsOf(primary.name).flatMap(entry => Object.keys(binsFor(session, entry))) } catch { return [] } })()
    if (!packages.length && names.length === 1) return await spawnProgram(join(root, 'node_modules/.bin', names[0]), names[0], rest, context)
    err(`npm error could not determine executable to run${names.length ? `\nnpm error available: ${names.join(', ')}` : ''}`)
    return 1
  }
  return await spawnProgram(bin, command, rest, context)
}

function binsFor(session, entry) {
  const manifest = JSON.parse(readText(join(session.scope.lib, entry.name, entry.version, 'package.json')))
  if (typeof manifest.bin === 'string') return { [manifest.name.split('/').pop()]: manifest.bin }
  return manifest.bin ?? {}
}

async function spawnProgram(path, name, args, context) {
  const bins = []
  for (let dir = context.cwd; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') { bins.push(join(dir, 'node_modules/.bin')); if (dir === '/') break }
  const dirOfPath = path.slice(0, path.lastIndexOf('/'))
  const environment = { ...env, PATH: [dirOfPath, ...bins.filter(exists), env['PATH'] ?? ''].filter(Boolean).join(':') }
  const pid = await custom('proc_spawn', path, JSON.stringify([name, ...args]), context.cwd, JSON.stringify({ env: environment }))
  return await custom('proc_wait', pid)
}

// Everything else

function init(context) {
  const dir = context.dir ?? context.cwd
  const path = join(dir, 'package.json')
  if (exists(path)) {
    out(`Wrote to ${path}:\n\n${readText(path).trimEnd()}\n`)
    return 0
  }
  const name = dir.split('/').filter(Boolean).pop() ?? 'package'
  const data = { name: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'), version: '1.0.0', description: '', main: 'index.js', scripts: { test: 'echo "Error: no test specified" && exit 1' }, keywords: [], author: '', license: 'ISC' }
  writeAtomic(path, JSON.stringify(data, null, 2) + '\n')
  out(`Wrote to ${path}:\n\n${JSON.stringify(data, null, 2)}\n`)
  return 0
}

async function view(context, operands) {
  const spec = operands[0] && parseSpec(operands[0])
  if (spec?.type !== 'registry') throw new Failure('npm error Usage: npm view <package> [field]', 1)
  const { registry } = context.session
  let document
  try { document = await registry.document(spec.name) } catch (error) { throw new Failure(`npm error code E404\nnpm error 404 ${error instanceof Error ? error.message : String(error)}`, 1) }
  const version = pickVersion(document, spec.range)
  const manifest = document.versions?.[version]
  if (!manifest) throw new Failure(`npm error code ETARGET\nnpm error notarget No matching version found for ${spec.name}@${spec.range}.`, 1)
  const field = operands[1]
  const data = { ...document, ...manifest, 'dist-tags': document['dist-tags'], versions: Object.keys(document.versions), maintainers: document.maintainers, time: document.time }
  if (field) {
    const value = field.split('.').reduce((current, key) => current?.[key], data)
    if (value === undefined) return 0
    out(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    return 0
  }
  if (context.o.json) { out(JSON.stringify(data, null, 2)); return 0 }
  const dependencies = Object.entries(manifest.dependencies ?? {})
  out([
    '',
    `${spec.name}@${version} | ${manifest.license ?? document.license ?? 'no license'} | deps: ${dependencies.length || 'none'} | versions: ${Object.keys(document.versions).length}`,
    manifest.description ?? document.description ?? '',
    manifest.homepage ?? document.homepage ?? '',
    ...(Object.keys(typeof manifest.bin === 'string' ? { [spec.name]: 1 } : manifest.bin ?? {}).length ? ['', `bin: ${Object.keys(typeof manifest.bin === 'string' ? { [spec.name.split('/').pop()]: 1 } : manifest.bin).join(', ')}`] : []),
    '', 'dist', `.tarball: ${manifest.dist?.tarball ?? ''}`, `.shasum: ${manifest.dist?.shasum ?? ''}`, `.integrity: ${manifest.dist?.integrity ?? ''}`,
    ...(dependencies.length ? ['', 'dependencies:', ...dependencies.map(([name, range]) => `${name}: ${range}`)] : []),
    '', 'dist-tags:', ...Object.entries(document['dist-tags'] ?? {}).map(([tag, value]) => `${tag}: ${value}`),
    ''
  ].filter((line, index) => index < 2 || line !== undefined).join('\n'))
  return 0
}

async function search(context, operands) {
  if (!operands.length) throw new Failure('npm error Usage: npm search <text>', 1)
  let found
  try { found = await context.session.registry.search(operands.join(' ')) } catch (error) { throw new Failure(`npm error ${error instanceof Error ? error.message : String(error)}`, 1) }
  if (!found.length) { err(`npm error No matches found for "${operands.join(' ')}"`); return 1 }
  const rows = [['NAME', 'DESCRIPTION', 'AUTHOR', 'DATE', 'VERSION'], ...found.map(item => [item.name, String(item.description ?? '').replace(/\s+/g, ' ').slice(0, 60), `=${item.publisher?.username ?? ''}`, String(item.date ?? '').slice(0, 10), item.version])]
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)))
  for (const row of rows) out(row.map((cell, column) => String(cell).padEnd(widths[column])).join(' | ').trimEnd())
  return 0
}

function config(context, operands) {
  const [action, key] = operands
  const registry = context.session.registry.url
  if (action === 'get') {
    if (key === 'registry') { out(registry); return 0 }
    out('undefined')
    return 0
  }
  if (action === 'list' || action === 'ls' || !action) {
    out(`; "default" config from the built-in defaults\nregistry = "${registry}"\n; cwd = ${context.cwd}`)
    return 0
  }
  err(`npm error The config ${action} command is not supported on ecmaOS: set REGISTRY in the environment, or pass --registry`)
  return 1
}

function cache(context, operands) {
  const { scope } = context.session
  if (operands[0] === 'clean' || operands[0] === 'rm' || operands[0] === 'prune') {
    if (!context.o.force && context.tool === 'npm') { err('npm error As of npm@5, the npm cache self-heals from corruption issues\nnpm error by treating integrity mismatches as cache misses.\nnpm error Pass --force to clear it anyway.'); return 1 }
    for (const directory of ['tarballs', 'meta', 'exec']) try { rmRecursive(join(scope.cache, directory)) } catch { /* empty already */ }
    if (context.tool === 'yarn') out('success Cleared cache.')
    return 0
  }
  if (operands[0] === 'dir' || operands[0] === 'path') { out(scope.cache); return 0 }
  err('npm error usage: npm cache clean --force')
  return 1
}

function why(context, operands) {
  const { db } = context.session
  let code = 0
  for (const name of operands) {
    const entries = db.versionsOf(name)
    if (!entries.length) { err(`error We couldn't find a match!`); code = 1; continue }
    for (const entry of entries) {
      const dependents = db.dependentsOf(entry.name, entry.version)
      out(`=> Why do I have the module "${name}"?\ninfo Has been hoisted to "${name}"\ninfo ${entry.explicit ? 'This module exists because it\'s specified in "dependencies".' : `This module exists because "${dependents.map(other => other.name).join('", "')}" depends on it.`}`)
    }
  }
  return code
}

// Entry

export async function run(tool, args) {
  try {
    return await dispatch(tool, args)
  } catch (error) {
    if (error instanceof Failure) { if (error.message) err(error.message); return error.code }
    err(`${tool === 'yarn' ? 'error' : 'npm error'} ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function dispatch(tool, args) {
  if (tool === 'npx') return await exec(context('npm', parseNpx(args)), parseNpx(args).rest)
  const o = parse(tool, args)
  if (o.version && !o.verb) { out(VERSIONS[tool]); return 0 }
  if (o.help || (!o.verb && tool !== 'yarn' && tool !== 'pnpm')) { out(usages[tool]); return o.help ? 0 : 1 }
  if (o.unknown && !o.verb) throw new Failure(`${tool === 'yarn' ? 'error' : 'npm error'} unknown option ${o.unknown}`, 1)
  let verb = o.verb
  let operands = o.positional
  if (tool === 'yarn' && verb === 'global') { o.global = true; verb = operands[0]; operands = operands.slice(1) }
  const table = VERBS[tool]
  let op = verb === undefined ? 'install' : table[verb]
  if (op === undefined) {
    if (NOT_AVAILABLE.has(verb)) throw new Failure(`${tool === 'yarn' ? 'error' : 'npm error'} ${verb} is not available on ecmaOS`, 1)
    if (SCRIPT_SHORTCUTS[tool] || tool === 'yarn') { op = 'run'; operands = [verb, ...operands] }
    else throw new Failure(`${tool === 'yarn' ? 'error' : 'npm error'} Unknown command: "${verb}"`, 1)
  }
  if (o.unknown && op !== 'exec' && op !== 'dlx' && !op.startsWith('script') && op !== 'run') throw new Failure(`${tool === 'yarn' ? 'error' : 'npm error'} unknown option ${o.unknown}`, 1)
  const ctx = context(tool, o)
  switch (op) {
    case 'install': return operands.length && tool !== 'yarn' ? await add(ctx, operands, { kind: 'install' }) : await installAll(ctx)
    case 'ci': return await installAll(ctx, { clean: true })
    case 'add': return await add(ctx, operands)
    case 'remove': return await remove(ctx, operands)
    case 'update': return await update(ctx, operands)
    case 'list': return list(ctx, operands)
    case 'outdated': return await outdated(ctx, operands)
    case 'prune': { const manifest = readManifest(ctx.dir); const removed = syncExplicit(ctx, new Set(Object.keys(dependenciesOf(manifest.data)))); out(`\n${removed ? `removed ${plural(removed, 'package')}` : 'up to date'}`); return 0 }
    case 'run': return await runScript(ctx, operands[0], [...operands.slice(1), ...o.rest])
    case 'exec': case 'dlx': return await exec(ctx, [...operands, ...o.rest])
    case 'init': case 'create': return init(ctx)
    case 'view': return await view(ctx, operands)
    case 'search': return await search(ctx, operands)
    case 'config': return config(ctx, operands)
    case 'cache': return cache(ctx, operands)
    case 'root': out(ctx.global ? ctx.session.scope.lib : join(ctx.dir, 'node_modules')); return 0
    case 'prefix': out(ctx.global ? ctx.session.scope.lib.replace(/\/lib$/, '') : ctx.dir); return 0
    case 'bin': out(ctx.global ? ctx.session.scope.bin : join(ctx.dir, 'node_modules/.bin')); return 0
    case 'version': out(JSON.stringify({ npm: VERSIONS.npm, ecmaos: 'on npm\'s registry' }, null, 2)); return 0
    case 'why': return why(ctx, operands)
    case 'noop': return 0
    case 'help': out(usages[tool]); return 0
  }
  if (op.startsWith('script:')) return await runScript(ctx, op.slice(7), [...operands, ...o.rest])
  return 0
}

function parseNpx(args) {
  const o = { rest: [], positional: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-y' || arg === '--yes') o.yes = true
    else if (arg === '--no' || arg === '-n') o.no = true
    else if (arg === '-p' || arg === '--package') (o.packages ??= []).push(args[++i])
    else if (arg.startsWith('--package=')) (o.packages ??= []).push(arg.slice(10))
    else if (arg === '--registry') o.registry = args[++i]
    else if (arg.startsWith('--registry=')) o.registry = arg.slice(11)
    else if (arg === '--offline') o.offline = true
    else if (arg === '-q' || arg === '--quiet' || arg === '--silent') o.silent = true
    else if (arg === '--') { o.rest.push(...args.slice(i + 1)); break }
    else if (arg.startsWith('-') && !o.rest.length) continue
    else { o.rest.push(...args.slice(i)); break }
  }
  return o
}
