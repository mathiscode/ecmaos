/**
 * `software`: finds, inspects and lists software from the package index, the way the Software window does. It is the
 * window's data (`--json`) and its text form for a terminal: `list` (categories and collections), `installed`,
 * `updates`, `search TEXT` (the index; `--npm` asks the registry too, and its results are not curated), `show NAME`, and
 * `gui` to open the window. Installing and removing are `install` / `install remove`, which the window runs as well.
 */
import { Failure, err, installed as installedRows, kilobytes, manifestOf, openSession, out, wrap } from './lib/install/frontend.mjs'
import { exists } from './lib/install/io.mjs'
import { cachedUpgradable, latestOf, newer } from './lib/install/updates.mjs'

const { argv, exit, custom, isDirectory } = globalThis.ecmaosSyscalls

const SCOPE = '@ecmaos-apps'

const usage = `Usage: software [list [CATEGORY|COLLECTION]]
       software installed
       software updates
       software search [--npm] TEXT
       software show NAME
       software gui
Find and inspect software. Install with 'install NAME' (or 'sudo install -g NAME' for everyone).

  list         the collections of programs by category, with how many of each are installed
  installed    what is installed, and what was asked for by name
  updates      installed packages with a newer version (asks the registry)
  search       the index, by name and description; --npm also asks the registry (not curated)
  show         one package: its version, size, license, source, dependencies and collections
  gui          opens the Software window
  --json       print the data the window reads
  --registry URL, --offline`

/** Parses the options of the command; everything else is an operand */
function parse(args) {
  const options = {}
  const operands = []
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]
    if (arg === '--json') options.json = true
    else if (arg === '--npm') options.npm = true
    else if (arg === '--offline') options.offline = true
    else if (arg === '--registry') options.registry = args[++at]
    else if (arg.startsWith('--registry=')) options.registry = arg.slice('--registry='.length)
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg.startsWith('-') && arg !== '-') throw new Failure(`unknown option ${arg}\nTry 'software --help' for more information.`, 1)
    else operands.push(arg)
  }
  return { options, operands }
}

const print = (options, data, text) => out(options.json ? JSON.stringify(data, null, 2) : text)

/** What is installed, by package name: `{ name: { version, explicit, scope } }`; the newest version of a name wins */
function stateOf(session) {
  const state = {}
  for (const { entry, scope } of installedRows(session)) {
    const had = state[entry.name]
    if (had && had.version > entry.version) continue
    state[entry.name] = { version: entry.version, explicit: Boolean(entry.explicit), system: Boolean(scope.system), seeded: Boolean(entry.seeded) }
  }
  return state
}

/** The program `name` stands for in the index: `{ name, package, ...description }` or nothing */
function programOf(index, name) {
  const found = index.programs?.[name] ?? index.programs?.[index.commands?.[name]]
  if (found) return { name: index.programs[name] ? name : index.commands[name], ...found }
  const common = index.common?.[name]
  if (common?.package) return { name, package: common.package, description: common.description, kind: common.meta ? 'collection' : 'package' }
  return undefined
}

/** The categories of the index: `[{ name, collections: [{ name, package, description, members: [...] }] }]`, the groups folded under theirs */
function categories(session) {
  const { index } = session
  const state = stateOf(session)
  const byCategory = new Map()
  for (const [name, group] of Object.entries(index.groups ?? {})) {
    const members = group.members.map(member => {
      const program = programOf(index, member) ?? { name: member, package: `${SCOPE}/${member}` }
      return { name: member, package: program.package, description: program.description ?? '', kind: program.kind ?? 'wasm', size: program.size, installed: Boolean(state[program.package]) }
    })
    const category = group.category ?? 'Other'
    if (!byCategory.has(category)) byCategory.set(category, [])
    byCategory.get(category).push({ name, package: `${SCOPE}/group-${name}`, description: group.description, installed: members.filter(member => member.installed).length, total: members.length, members })
  }
  return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, collections]) => ({ name, collections: collections.sort((a, b) => a.name.localeCompare(b.name)) }))
}

function list(session, options, [wanted]) {
  let found = categories(session)
  if (wanted) {
    const lower = wanted.toLowerCase()
    found = found.map(category => ({ ...category, collections: category.collections.filter(collection => category.name.toLowerCase() === lower || collection.name === lower) })).filter(category => category.collections.length)
    if (!found.length) throw new Failure(`software: no category or collection named ${wanted}`, 1)
  }
  const detailed = Boolean(wanted)
  const lines = []
  for (const category of found) {
    lines.push(category.name)
    for (const collection of category.collections) {
      lines.push(`  ${collection.name.padEnd(12)} ${String(collection.installed).padStart(2)}/${collection.total} installed  ${collection.description}`)
      if (detailed) for (const member of collection.members) lines.push(`    ${member.installed ? '*' : ' '} ${member.name.padEnd(14)} ${member.description}`)
    }
  }
  print(options, { categories: found }, lines.join('\n'))
  return 0
}

function installed(session, options) {
  const state = stateOf(session)
  const upgradable = new Map()
  for (const { entry } of installedRows(session)) {
    const latest = session.registry.cached(entry.name)?.['dist-tags']?.latest
    if (latest) upgradable.set(entry.name, latest)
  }
  const newerOnes = new Set(cachedUpgradable(session.registry, installedRows(session).map(row => row.entry)).map(entry => entry.name))
  const rows = installedRows(session).map(({ entry, scope }) => {
    const manifest = manifestOf(scope, entry)
    return { name: entry.name, version: entry.version, explicit: Boolean(entry.explicit), collection: Boolean(manifest.ecmaos?.meta), system: Boolean(scope.system), description: String(manifest.description ?? '').replace(/\s+/g, ' '), upgradable: newerOnes.has(entry.name) ? upgradable.get(entry.name) : undefined }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const line = row => `  ${row.name}@${row.version}${row.upgradable ? ` (${row.upgradable} available)` : ''}${row.description ? `  ${row.description}` : ''}`
  const asked = rows.filter(row => row.explicit && !row.collection)
  const collections = rows.filter(row => row.collection && row.explicit)
  const rest = rows.filter(row => !row.explicit && !row.collection)
  const text = [
    `Asked for by name (${asked.length})`, ...asked.map(line),
    `Collections (${collections.length})`, ...collections.map(line),
    `Installed as dependencies (${rest.length})`, ...rest.map(line)
  ].join('\n')
  print(options, { installed: rows, count: Object.keys(state).length }, text)
  return 0
}

async function updates(session, options) {
  const entries = installedRows(session).map(row => row.entry).filter(entry => !entry.seeded)
  const warnings = []
  const latest = await latestOf(session.registry, entries, message => warnings.push(message))
  const due = newer(entries, latest).map(entry => ({ name: entry.name, installed: entry.version, latest: latest[entry.name].latest }))
  if (!options.json) for (const warning of warnings) err(`software: ${warning}`)
  print(options, { updates: due, unreachable: warnings }, due.length ? due.map(row => `  ${row.name}  ${row.installed} -> ${row.latest}`).join('\n') + `\n${due.length} can be upgraded: install upgrade` : 'Everything is up to date.')
  return 0
}

/** Index entries whose name or description contains every word of `text` */
function searchIndex(session, text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const state = stateOf(session)
  const seen = new Map()
  const consider = (name, entry, kind) => {
    const haystack = `${name} ${entry.description ?? ''}`.toLowerCase()
    if (!words.every(word => haystack.includes(word)) || !entry.package || seen.has(entry.package)) return
    seen.set(entry.package, { name, package: entry.package, description: entry.description ?? '', kind, installed: Boolean(state[entry.package]), source: 'index' })
  }
  for (const [name, program] of Object.entries(session.index.programs ?? {})) consider(name, program, program.kind ?? 'wasm')
  for (const [name, entry] of Object.entries(session.index.common ?? {})) consider(name, entry, entry.meta ? 'collection' : 'package')
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function search(session, options, operands) {
  const text = operands.join(' ')
  if (!text) throw new Failure('software: search needs some text', 1)
  const found = searchIndex(session, text)
  const lines = found.map(row => `${row.installed ? '*' : ' '} ${row.name.padEnd(16)} ${row.description}`)
  let unvetted = []
  let problem
  if (options.npm) {
    try {
      const known = new Set(found.map(row => row.package))
      unvetted = (await session.registry.search(text, 20)).filter(row => !known.has(row.name)).map(row => ({ name: row.name, package: row.name, version: row.version, description: row.description ?? '', publisher: row.publisher?.username, date: row.date, installed: false, source: 'npm' }))
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    lines.push('', 'More on npm (not curated by ecmaOS: anyone can publish these)')
    if (problem) lines.push(`  the registry did not answer: ${problem}`)
    for (const row of unvetted) lines.push(`  ${row.name}@${row.version}  ${row.description}${row.publisher ? `  [${row.publisher}${row.date ? `, ${String(row.date).slice(0, 10)}` : ''}]` : ''}`)
  } else if (!found.length) {
    lines.push('Nothing in the index. Try --npm to search the registry.')
  }
  print(options, { results: found, npm: options.npm ? unvetted : undefined, unreachable: problem }, lines.join('\n'))
  return found.length || unvetted.length ? 0 : 1
}

/** Whether the installed package's bin is a DOM app, by its first line */
function kindOfInstalled(scope, entry, manifest) {
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})
  for (const bin of bins) {
    try {
      const { read, open, close, O_RDONLY } = globalThis.ecmaosSyscalls
      const fd = open(`${scope.lib}/${entry.name}/${entry.version}/${bin}`, O_RDONLY)
      const head = new Uint8Array(40)
      const count = read(fd, head, -1)
      close(fd)
      const line = new TextDecoder().decode(head.subarray(0, count))
      if (line.startsWith('#!ecmaos:bin:app:')) return 'app'
      if (line.startsWith('\0asm') || bin.endsWith('.wasm')) return 'wasm'
    } catch { /* unreadable */ }
  }
  return 'package'
}

async function show(session, options, [name]) {
  if (!name) throw new Failure('software: show needs a name', 1)
  const { index } = session
  const known = programOf(index, name)
  const packageName = known?.package ?? (index.groups?.[name] ? `${SCOPE}/group-${name}` : name)
  const rows = installedRows(session).filter(row => row.entry.name === packageName).sort((a, b) => (a.entry.version < b.entry.version ? 1 : -1))
  const here = rows[0]
  const manifest = here ? manifestOf(here.scope, here.entry) : {}
  let remote
  let unreachable
  if (!options.offline && !here?.entry.seeded) {
    try { remote = (await session.registry.metadata(packageName)) } catch (error) { unreachable = error instanceof Error ? error.message : String(error) }
  }
  const latest = remote?.['dist-tags']?.latest
  const latestManifest = latest ? remote.versions?.[latest] : undefined
  if (!here && !known && !latestManifest && !index.groups?.[name]) throw new Failure(`software: ${name} is not installed, in the index${unreachable ? ' or reachable on the registry (' + unreachable + ')' : ' or on the registry'}`, 1)
  const facts = latestManifest ?? manifest
  const belongs = Object.entries(index.groups ?? {}).filter(([, group]) => group.members.includes(known?.name ?? name)).map(([group]) => group)
  const profiles = Object.entries(index.profiles ?? {}).filter(([, profile]) => (profile.packages ?? []).includes(known?.name ?? name) || belongs.some(group => (profile.groups ?? []).includes(group))).map(([profile]) => profile)
  const kind = here && !here.entry.seeded ? kindOfInstalled(here.scope, here.entry, manifest) : (known?.kind === 'script' ? 'package' : known?.kind ?? (index.groups?.[name] ? 'collection' : 'package'))
  const record = {
    name: packageName,
    command: known?.name,
    description: String(facts.description ?? known?.description ?? index.groups?.[name]?.description ?? '').replace(/\s+/g, ' '),
    kind: manifest.ecmaos?.meta || index.groups?.[name] ? 'collection' : kind,
    installed: here ? { version: here.entry.version, explicit: Boolean(here.entry.explicit), everyone: Boolean(here.scope.system) } : undefined,
    latest,
    size: facts.dist?.unpackedSize ?? known?.size,
    license: facts.license ?? known?.license,
    homepage: facts.homepage ?? known?.homepage,
    source: facts.ecmaos?.source ?? (known?.source ? `${known.source}` : undefined),
    deprecated: latestManifest?.deprecated,
    dependencies: Object.keys(facts.dependencies ?? {}),
    collections: belongs,
    profiles,
    everyoneOnly: Boolean(facts.ecmaos?.runtime || known?.system),
    registry: session.registry.url,
    unreachable
  }
  const lines = [
    `${record.name}${record.installed ? ` ${record.installed.version}` : latest ? ` ${latest}` : ''}  (${record.kind})`,
    ...wrap(record.description.split(/\s+/), '  '),
    '',
    `  Installed:    ${record.installed ? `${record.installed.version}, ${record.installed.explicit ? 'asked for by name' : 'as a dependency'}, for ${record.installed.everyone ? 'everyone' : 'you'}${latest && latest !== record.installed.version ? `; ${latest} is available` : ''}` : 'no'}`,
    ...(record.size ? [`  Size:         ${kilobytes(record.size)}`] : []),
    ...(record.license ? [`  License:      ${record.license}`] : []),
    ...(record.homepage ? [`  Homepage:     ${record.homepage}`] : []),
    ...(record.collections.length ? [`  Collections:  ${record.collections.join(', ')}${record.profiles.length ? ` (in ${record.profiles.join(', ')})` : ''}`] : []),
    ...(record.dependencies.length ? [`  Depends on:   ${record.dependencies.join(', ')}`] : []),
    ...(record.source ? [`  Source:       apt source ${record.command ?? name}  (${String(record.source).replace(/@[^@/]+$/, '')})`] : []),
    ...(record.everyoneOnly ? ['  Install for:  everyone only (sudo install -g ' + record.name + '); it needs files under /usr'] : []),
    ...(record.deprecated ? [`  Deprecated:   ${record.deprecated}`] : []),
    ...(unreachable ? [`  (the registry did not answer: ${unreachable})`] : [])
  ]
  print(options, record, lines.join('\n'))
  return 0
}

/** Opens the Software window: the `software-gui` app, which is its own package */
async function gui() {
  const path = ['/usr/bin/software-gui', '/bin/software-gui', `${(globalThis.ecmaosSyscalls.env['HOME'] || '')}/.local/bin/software-gui`].find(candidate => {
    try { return exists(candidate) || isDirectory(candidate) } catch { return false }
  })
  if (!path) {
    err(`software: the window is the package ${SCOPE}/software; install it with 'install ${SCOPE}/software'. The text commands work without it (software --help).`)
    return 1
  }
  const pid = await custom('proc_spawn', path, JSON.stringify(['software-gui']), '')
  return await custom('proc_wait', pid)
}

try {
  const { options, operands } = parse(argv.slice(1))
  if (options.help) { err(usage); exit(0) }
  const [verb = 'list', ...rest] = operands
  if (verb === 'gui') exit(await gui())
  const session = openSession({ registry: options.registry, offline: options.offline })
  if (verb === 'list') exit(list(session, options, rest))
  else if (verb === 'installed') exit(installed(session, options))
  else if (verb === 'updates') exit(await updates(session, options))
  else if (verb === 'search') exit(await search(session, options, rest))
  else if (verb === 'show') exit(await show(session, options, rest))
  else { err(usage); exit(1) }
} catch (error) {
  err(error instanceof Failure ? error.message : `software: ${error instanceof Error ? error.message : String(error)}`)
  exit(error instanceof Failure ? error.code : 1)
}
