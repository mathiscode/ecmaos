/**
 * The machine's profile: which of ecmaOS's programs it keeps (`minimal`, `standard`, `developer`, `everything`).
 * `profile` shows it, `profile list` lists them, and `profile set NAME` changes it: going down removes the programs only
 * the bigger profile wanted (never one installed by name), after showing the plan; going up records the choice, installs
 * what the registry has and leaves the rest to the next boot, which installs what the site's catalog carries.
 */
import { Database, keyOf, scopeOf } from './lib/install/db.mjs'
import { Engine } from './lib/install/engine.mjs'
import { confirm } from './lib/install/frontend.mjs'
import { mkdirp, readText, writeAtomic } from './lib/install/io.mjs'
import { loadIndex } from './lib/install/names.mjs'
import { openRegistry } from './lib/install/registry.mjs'

const { argv, exit, write, geteuid } = globalThis.ecmaosSyscalls

const PROFILE_FILE = '/etc/ecmaos/profile'
const SCOPE = '@ecmaos-apps'
const META_VERSION = '1.0.0'
const LIB = '/usr/lib'
const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(text + '\n'))
const err = text => write(2, encoder.encode(text + '\n'))

const usage = `Usage: profile [show]
       profile list
       profile set [-y] NAME
Show, list or change the profile: minimal, standard, developer or everything.

  -y, --yes    do not ask before removing programs
  --offline    do not ask the registry for the programs of a bigger profile`

const current = () => { try { return readText(PROFILE_FILE).trim() } catch { return undefined } }

/** The programs a profile has, from the index: its own packages and the members of its groups */
const programsOf = (index, name) => {
  const profile = index.profiles?.[name]
  return new Set([...(profile?.packages ?? []), ...(profile?.groups ?? []).flatMap(group => index.groups?.[group]?.members ?? [])])
}

/** The profile meta-package for `name` in the database: written beside its group packages, with the versions installed */
function recordMeta(db, index, name) {
  const profile = index.profiles[name]
  const versionOf = program => db.versionsOf(`${SCOPE}/${program}`)[0]?.version
  const writeMeta = (packageName, dependencies, explicit) => {
    const directory = `${LIB}/${packageName}/${META_VERSION}`
    mkdirp(directory)
    writeAtomic(`${directory}/package.json`, JSON.stringify({ name: packageName, version: META_VERSION, dependencies: Object.fromEntries(Object.keys(dependencies).map(dependency => [dependency, 'latest'])), ecmaos: { meta: true } }, null, 2) + '\n')
    db.set({ name: packageName, version: META_VERSION, explicit, dependencies, installed: new Date().toISOString() })
  }
  const groupDependencies = {}
  for (const group of profile.groups) {
    const dependencies = {}
    for (const member of index.groups[group].members) {
      const version = versionOf(member)
      if (version) dependencies[`${SCOPE}/${member}`] = version
    }
    if (!Object.keys(dependencies).length) continue
    writeMeta(`${SCOPE}/group-${group}`, dependencies, false)
    groupDependencies[`${SCOPE}/group-${group}`] = META_VERSION
  }
  const packages = {}
  for (const member of profile.packages ?? []) { const version = versionOf(member); if (version) packages[`${SCOPE}/${member}`] = version }
  writeMeta(`${SCOPE}/profile-${name}`, { ...packages, ...groupDependencies }, true)
}

async function show() {
  const name = current()
  out(name ? `${name}` : 'none recorded (the first boot records one)')
  return 0
}

function list() {
  const { index } = loadIndex(scopeOf({ global: true }))
  const here = current()
  for (const [name, profile] of Object.entries(index.profiles ?? {})) out(`${name === here ? '*' : ' '} ${name.padEnd(10)} ${profile.description}`)
  return 0
}

async function set(options, name) {
  if (geteuid() !== 0) { err('profile: changing the profile needs root (sudo profile set ...)'); return 1 }
  const scope = scopeOf({ global: true })
  const { index } = loadIndex(scope)
  if (!index.profiles?.[name]) { err(`profile: no profile named ${name} (${Object.keys(index.profiles ?? {}).join(', ')})`); return 1 }
  const from = current()
  if (from === name) { out(`Already ${name}.`); return 0 }
  const db = new Database(scope)
  const registry = openRegistry(options, scope.cache)
  const engine = new Engine({ scope, db, registry, options: { ...options, quiet: true } })

  const wanted = programsOf(index, name)
  const had = from && index.profiles[from] ? programsOf(index, from) : new Set()
  const going = [...had].filter(program => !wanted.has(program))
  // only the programs the profile brought: one installed by name (explicit) is the user's
  const removable = going.map(program => db.versionsOf(`${SCOPE}/${program}`)).flat().filter(entry => !entry.explicit)
  if (removable.length) {
    out(`These programs belong to ${from} and not to ${name}, and will be removed:\n  ${removable.map(entry => keyOf(entry.name, entry.version)).join('\n  ')}`)
    if (!options.yes && !confirm('Do you want to continue?', false)) { out('Abort.'); return 1 }
    for (const entry of removable) {
      // a group that wanted it no longer does; the exclusion `remove` makes is not wanted here, since a bigger profile brings it back
      for (const parent of db.dependentsOf(entry.name, entry.version)) { delete parent.dependencies[entry.name]; db.set(parent) }
      if (!engine.removeEntry(entry)) { err(`profile: could not remove ${entry.name}`); db.save(); return 1 }
    }
  }
  // the old profile and the groups it had that the new one does not
  for (const old of db.all().filter(entry => entry.name.startsWith(`${SCOPE}/profile-`) || (entry.name.startsWith(`${SCOPE}/group-`) && !(index.profiles[name].groups ?? []).includes(entry.name.slice(`${SCOPE}/group-`.length))))) {
    engine.removeEntry(old)
  }
  // what a bigger profile has is not "taken out on purpose"
  for (const program of wanted) db.exclude(`${SCOPE}/${program}`, false)
  recordMeta(db, index, name)
  db.save()
  mkdirp('/etc/ecmaos')
  writeAtomic(PROFILE_FILE, `${name}\n`)
  out(`The profile is ${name}.`)

  const missing = [...wanted].filter(program => !db.versionsOf(`${SCOPE}/${program}`).length)
  if (missing.length && !options.offline) {
    out(`Installing the ${missing.length} programs ${name} adds from the registry...`)
    const code = await engine.install([{ name: `${SCOPE}/profile-${name}`, range: 'latest' }])
    if (code) out('The registry could not provide them; the next boot installs what the site carries.')
  } else if (missing.length) {
    out(`${missing.length} programs are added at the next boot.`)
  }
  return 0
}

try {
  const args = argv.slice(1)
  const options = {}
  const operands = []
  for (const arg of args) {
    if (arg === '-y' || arg === '--yes') options.yes = true
    else if (arg === '--offline') options.offline = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\nTry 'profile --help' for more information.`)
    else operands.push(arg)
  }
  const [verb = 'show', name] = operands
  if (options.help) { err(usage); exit(0) }
  else if (verb === 'show') exit(await show())
  else if (verb === 'list') exit(list())
  else if (verb === 'set' && name) exit(await set(options, name))
  else { err(usage); exit(1) }
} catch (error) {
  err(`profile: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
