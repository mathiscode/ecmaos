/**
 * What the front-ends (`apt`, `dpkg`, `pacman`, `npm`...) share: a session over the engine, turning the names a
 * distribution's tool is given into npm packages through the index, asking the user to go on, and describing what is
 * installed (its files, its owner) in the terms those tools use.
 */

import { join } from '../path-utils.mjs'
import { Database, binsOf, projectScope, scopeOf } from './db.mjs'
import { Engine } from './engine.mjs'
import { names, readJson } from './io.mjs'
import { loadIndex, lookup, nameFor, parseTarget } from './names.mjs'
import { openRegistry } from './registry.mjs'

const { write, read, geteuid, env, isDirectory, readlink } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
export const out = text => write(1, encoder.encode(text + '\n'))
export const err = text => write(2, encoder.encode(text + '\n'))

/** Thrown to end a command with a message and an exit status */
export class Failure extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

/**
 * The scope, database, registry, engine and index a front-end works with. `options.global` / `options.user` pick the
 * scope as `install` does; `options.project` is a directory for an `npm`-style project install. The engine is quiet:
 * the front-end tells the story. `options.placed(node)` hears each package as it is unpacked.
 */
export function openSession(options = {}) {
  const scope = options.project ? projectScope(options.project, options) : scopeOf(options)
  const db = new Database(scope)
  const registry = openRegistry(options, scope.cache)
  const engine = new Engine({ scope, db, registry, options: { ...options, quiet: true } })
  const loaded = loadIndex(scope)
  return { scope, db, registry, engine, index: loaded.index, indexVersion: loaded.version, options }
}

/** Whether the caller is root, which decides whether the front-ends install for the whole system */
export const isRoot = () => geteuid() === 0

/** The `home`-relative form of a path, for a message */
export const tilde = path => (env['HOME'] && path.startsWith(env['HOME'] + '/') ? `~${path.slice(env['HOME'].length)}` : path)

/**
 * Turns the names on a command line into what the engine takes. Gives `requests` (`{ name, range }` for npm packages),
 * `provided` (names ecmaOS ships already, with the note), and `missing` (names the index does not know).
 */
export function translate(session, manager, targets) {
  const requests = []
  const provided = []
  const missing = []
  for (const target of targets) {
    const { name, range } = parseTarget(target, manager)
    const entry = lookup(session.index, manager, name)
    if (!entry) { missing.push(name); continue }
    if (entry.provided) { provided.push({ name, note: entry.provided }); continue }
    if (!requests.some(request => request.name === entry.package)) requests.push({ name: entry.package, range: range ?? entry.range, asked: name })
  }
  return { requests, provided, missing }
}

/** `[ [name, version, description] ]` of npm packages close to `name`, to point a user at when the index does not know it */
export async function suggest(session, name, limit = 3) {
  try {
    return (await session.registry.search(name, limit)).map(found => ({ name: found.name, version: found.version, description: String(found.description ?? '').replace(/\s+/g, ' ') }))
  } catch {
    return []
  }
}

/** Reads one line from standard input; `undefined` at the end of the input */
export function readLine() {
  const bytes = []
  const one = new Uint8Array(1)
  for (;;) {
    const count = read(0, one, -1)
    if (count <= 0) return bytes.length ? new TextDecoder().decode(new Uint8Array(bytes)) : undefined
    if (one[0] === 10) return new TextDecoder().decode(new Uint8Array(bytes))
    bytes.push(one[0])
  }
}

/** Asks `question` ([Y/n] by default); the answer is yes on an empty line or one starting with y */
export function confirm(question, fallback = true) {
  write(1, encoder.encode(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `))
  const answer = readLine()
  if (answer === undefined) return false
  const text = answer.trim().toLowerCase()
  return text === '' ? fallback : text.startsWith('y')
}

/** Breaks `words` into lines at `width`, each indented by `indent` */
export function wrap(words, indent = '  ', width = 78) {
  const lines = []
  let line = indent
  for (const word of words) {
    if (line.length > indent.length && line.length + 1 + word.length > width) { lines.push(line); line = indent }
    line += (line.length > indent.length ? ' ' : '') + word
  }
  if (line.length > indent.length) lines.push(line)
  return lines.join('\n')
}

/** `1,234 kB`: apt's sizes, in thousands */
export function kilobytes(bytes) {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000)).toLocaleString('en-US')} kB`
}

/** The installed packages `session` can see: the scope's own and, for a user, the system's behind them (not the version kept for a rollback) */
export function installed(session, { system = true } = {}) {
  const rows = session.db.all().filter(entry => !entry.kept).map(entry => ({ entry, scope: session.scope, db: session.db }))
  if (system && !session.scope.system && !session.scope.project) {
    const scope = scopeOf({ global: true })
    const db = new Database(scope)
    for (const entry of db.all().filter(entry => !entry.kept)) rows.push({ entry, scope, db })
  }
  return rows
}

/** `package.json` of an installed package */
export const manifestOf = (scope, entry) => readJson(join(scope.lib, entry.name, entry.version, 'package.json'), {})

/** The directory an installed package lives in */
export const directoryOf = (scope, entry) => join(scope.lib, entry.name, entry.version)

/** A package's size on disk, summed over its files (not its `node_modules`) */
export function sizeOf(directory) {
  let total = 0
  const { stat } = globalThis.ecmaosSyscalls
  for (const file of filesIn(directory)) {
    try { total += Number(stat(file).size) || 0 } catch { /* gone */ }
  }
  return total
}

/** Every file under `directory` (no `node_modules`), as absolute paths */
export function filesIn(directory) {
  const found = []
  const visit = path => {
    let children
    try { children = names(path) } catch { return }
    for (const child of children) {
      if (child === 'node_modules') continue
      const full = join(path, child)
      if (isDirectory(full)) visit(full)
      else found.push(full)
    }
  }
  visit(directory)
  return found.sort()
}

/** The paths a package owns: its files in `lib`, the bins linked from `bin`, the `share/` files linked into `share` */
export function ownedPaths(scope, entry) {
  const directory = directoryOf(scope, entry)
  const manifest = manifestOf(scope, entry)
  const paths = filesIn(directory)
  for (const bin of Object.keys(binsOf(manifest))) {
    const path = join(scope.bin, bin)
    try { if (readlink(path).startsWith(directory + '/')) paths.push(path) } catch { /* not linked */ }
  }
  return paths.sort()
}

/** The installed package that owns `path` (a file in its directory, or a link into it), or `undefined` */
export function ownerOf(session, path) {
  let real = path
  try { real = readlink(path) } catch { /* not a link */ }
  for (const { entry, scope, db } of installed(session)) {
    const directory = directoryOf(scope, entry)
    if (path.startsWith(directory + '/') || real.startsWith(directory + '/')) return { entry, scope, db }
  }
  return undefined
}

/** The name `manager` shows for an installed package */
export const displayName = (session, manager, entry) => nameFor(session.index, manager, entry.name)

/** The description of an installed package, from its manifest */
export const descriptionOf = (scope, entry) => String(manifestOf(scope, entry).description ?? '').replace(/\s+/g, ' ')

/** `a (>= 1.0), b`: a manifest's dependencies as a Debian `Depends` line */
export function dependsOf(manifest, session, manager) {
  return Object.entries(manifest.dependencies ?? {}).map(([name, range]) => `${nameFor(session.index, manager, name)}${range && range !== '*' ? ` (${range})` : ''}`)
}
