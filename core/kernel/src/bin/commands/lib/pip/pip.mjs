/**
 * `pip` over PyPI's JSON API. It installs pure-Python wheels into CPython's `site-packages` (the system's as root, the
 * user's under `~/.local` otherwise), follows `Requires-Dist` with markers, checks each wheel against the SHA-256 PyPI
 * publishes, and keeps no database of its own: what is installed is what `site-packages` has, in the `dist-info`
 * directories Python's tools read. Native wheels and source distributions are refused with the reason.
 */

import { join, resolve as resolvePath } from '../path-utils.mjs'
import { exists, pool, readBytes, readText, size } from '../install/io.mjs'
import { Failure, confirm, err, out } from '../install/frontend.mjs'
import { Index, pureWheel } from './pypi.mjs'
import { applies, compareVersions, environment, normalize, parseRequirement, satisfies, formatSpecifier } from './pep440.mjs'
import { resolve } from './resolve.mjs'
import { entriesOf, read } from './zip.mjs'
import { installWheel, installed as listInstalled, parseHeaders, pythonVersion, sitesOf, targetOf, uninstallDistribution, recorded } from './site.mjs'

const { getcwd, rmRecursive } = globalThis.ecmaosSyscalls

const VERSION = '25.3'

const usage = `Usage:
  pip <command> [options]

Commands:
  install      Install packages.
  uninstall    Uninstall packages.
  list         List installed packages.
  freeze       Output installed packages in requirements format.
  show         Show information about installed packages.
  check        Verify installed packages have compatible dependencies.
  index        Inspect information available from package indexes (index versions).
  cache        Inspect and manage pip's wheel cache.
  config       List the configuration (the index in use).
  help         Show help for commands.

General Options:
  -h, --help            Show help.
  --version             Show version and exit.
  -q, --quiet           Give less output.
  -i, --index-url URL   Base URL of the package index (default $PIP_INDEX_URL, else https://pypi.org).
  --user                Install to the user site (~/.local).
  --offline             Use only the cache.

Wheels only: packages with native code, and source distributions, cannot be installed on ecmaOS.`

function parse(args) {
  const o = { positional: [], requirements: [] }
  const takes = new Set(['-i', '--index-url', '-r', '--requirement', '--extra-index-url', '-c', '--constraint', '--target', '-t', '--only-binary', '--no-binary', '--format', '--python', '--cache-dir', '--timeout', '--retries', '-f', '--find-links', '--root', '--prefix', '--progress-bar'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = () => (arg.includes('=') && arg.startsWith('--') ? arg.slice(arg.indexOf('=') + 1) : args[++i])
    const name = arg.startsWith('--') ? arg.split('=')[0] : arg
    if (arg === '--') { o.positional.push(...args.slice(i + 1)); break }
    if (name === '-h' || name === '--help') o.help = true
    else if (name === '--version' || name === '-V') o.version = true
    else if (name === '-q' || name === '--quiet') o.quiet = (o.quiet ?? 0) + 1
    else if (/^-q+$/.test(arg)) o.quiet = (o.quiet ?? 0) + arg.length - 1
    else if (name === '-v' || name === '--verbose') o.verbose = true
    else if (name === '-i' || name === '--index-url') o.index = value()
    else if (name === '-r' || name === '--requirement') o.requirements.push(value())
    else if (name === '--user') o.user = true
    else if (name === '-U' || name === '--upgrade') o.upgrade = true
    else if (name === '--no-deps') o.noDeps = true
    else if (name === '--pre') o.pre = true
    else if (name === '--force-reinstall') o.force = true
    else if (name === '--ignore-installed' || name === '-I') o.force = true
    else if (name === '--dry-run') o.dryRun = true
    else if (name === '-y' || name === '--yes') o.yes = true
    else if (name === '--offline') o.offline = true
    else if (name === '--outdated' || name === '-o') o.outdated = true
    else if (name === '--local' || name === '-l' || name === '--not-required') o.notRequired = name === '--not-required'
    else if (name === '--files' || name === '-f') o.files = true
    else if (name === '--format') o.format = value()
    else if (name === '-e' || name === '--editable') o.editable = true
    else if (takes.has(name)) value()
    else if (arg.startsWith('-') && arg.length > 1) { if (!/^--(no-|disable-|break-|require-|prefer-|use-|isolated|trusted|exists-action|no-warn|only-binary|compile|upgrade-strategy|root-user)/.test(arg)) o.unknown = arg }
    else o.positional.push(arg)
  }
  return o
}

const say = (o, text) => { if (!o.quiet) out(text) }

/** The distributions pip sees, by normalised name; the user site wins over the system's */
function installedMap() {
  const map = new Map()
  for (const distribution of listInstalled()) if (!map.has(distribution.key)) map.set(distribution.key, distribution)
  return map
}

function requirementsFrom(o) {
  const texts = [...o.positional]
  for (const file of o.requirements) {
    const path = resolvePath(getcwd(), file)
    if (!exists(path)) throw new Failure(`ERROR: Could not open requirements file: [Errno 2] No such file or directory: '${file}'`, 1)
    for (const raw of readText(path).split(/\r?\n/)) {
      const line = raw.replace(/(^|\s)#.*$/, '').trim()
      if (!line || line.startsWith('-')) continue
      texts.push(line)
    }
  }
  return texts
}

/** A wheel given as a file or a URL: `{ name, version, requires, bytes, filename }` */
async function localWheel(spec) {
  let bytes
  let filename = spec.split('/').pop()
  if (/^https?:\/\//.test(spec)) {
    const response = await globalThis.fetch(spec)
    if (!response.ok) throw new Failure(`ERROR: Could not install packages due to an OSError: ${spec} answered ${response.status}`, 1)
    bytes = new Uint8Array(await response.arrayBuffer())
  } else {
    const path = resolvePath(getcwd(), spec)
    if (!exists(path)) throw new Failure(`ERROR: Invalid requirement: '${spec}'\nHint: It looks like a path. File '${spec}' does not exist.`, 1)
    bytes = readBytes(path)
  }
  const entries = entriesOf(bytes)
  const metadataEntry = entries.find(entry => /^[^/]+\.dist-info\/METADATA$/.test(entry.name))
  if (!metadataEntry) throw new Failure(`ERROR: ${filename} is not a wheel (no METADATA)`, 1)
  const headers = parseHeaders(new TextDecoder().decode(await read(bytes, metadataEntry)))
  return { name: headers.Name?.[0], version: headers.Version?.[0], requires: headers['Requires-Dist'] ?? [], bytes, filename }
}

async function install(o) {
  const texts = requirementsFrom(o)
  if (!texts.length) throw new Failure('ERROR: You must give at least one requirement to install (see "pip help install")', 1)
  if (o.editable) throw new Failure('ERROR: Editable installs are not supported on ecmaOS (they build a source tree)', 1)
  const target = targetOf({ user: o.user })
  if (!target.system && !o.user) say(o, 'Defaulting to user installation because normal site-packages is not writeable')
  const index = new Index(o.index, target.cache, { offline: o.offline })
  const python = `${pythonVersion()}.0`
  const env = environment(python)
  const requests = []
  for (const text of texts) {
    if (/\.whl$/.test(text) || /^https?:\/\/.+\.whl(\?.*)?$/.test(text)) {
      const local = await localWheel(text)
      requests.push({ requirement: parseRequirement(`${local.name}==${local.version}`), text, local })
      continue
    }
    if (/^(\.|\/|~)/.test(text) || /\.(tar\.gz|zip|tgz)$/.test(text) || /^(git\+|https?:\/\/)/.test(text)) {
      throw new Failure(`ERROR: ${text} is a source distribution or a directory; only wheels can be installed on ecmaOS (nothing here builds from source)`, 1)
    }
    try { requests.push({ requirement: parseRequirement(text), text }) } catch { throw new Failure(`ERROR: Invalid requirement: '${text}'`, 1) }
  }
  const have = installedMap()
  const shown = new Set()
  let plan
  try {
    plan = await resolve(index, requests, {
      python, env, installed: have, upgrade: o.upgrade, force: o.force, noDeps: o.noDeps, prereleases: o.pre,
      onSatisfied: (requirement, distribution, parent) => {
        const key = `${requirement.name}${formatSpecifier(requirement.specifier)}`
        if (shown.has(key)) return
        shown.add(key)
        say(o, `Requirement already satisfied: ${requirement.name}${formatSpecifier(requirement.specifier)} in ${distribution.site} ${parent ? `(from ${parent.name}) ` : ''}(${distribution.version})`)
      }
    })
  } catch (error) {
    throw new Failure(`ERROR: ${error instanceof Error ? error.message : String(error)}\n${/Could not find a version/.test(String(error?.message)) ? `ERROR: No matching distribution found for ${texts.map(text => text.replace(/[<>=!~;\s].*$/, '')).join(', ')}` : ''}`.trimEnd(), 1)
  }
  const nodes = plan.order
  if (!nodes.length) {
    return 0
  }
  // fetch the wheels, a few at a time, and say what pip says in the order it found them
  const wheels = new Map()
  const fetched = await pool(nodes.filter(node => !node.local), 4, async node => {
    try {
      wheels.set(node.key, await index.wheel(node.file))
      return undefined
    } catch (error) {
      return `${node.name}: ${error instanceof Error ? error.message : String(error)}`
    }
  })
  const failures = fetched.filter(Boolean)
  if (failures.length) throw new Failure(failures.map(message => `ERROR: ${message}`).join('\n'), 1)
  for (const node of plan.discovered) {
    say(o, `Collecting ${node.local ? node.local.filename : node.key}`)
    if (node.local) { say(o, `  Processing ${node.local.filename}`); continue }
    const wheel = wheels.get(node.key)
    say(o, wheel.cached ? `  Using cached ${node.file.filename} (${size(wheel.bytes.length)})` : `  Downloading ${node.file.filename} (${size(wheel.bytes.length)})`)
  }
  if (o.dryRun) {
    out(`Would install ${nodes.map(node => `${node.name}-${node.version}`).join(' ')}`)
    return 0
  }
  for (const node of nodes) {
    if (!node.replaces) continue
    say(o, `Attempting uninstall: ${node.replaces.name}\n  Found existing installation: ${node.replaces.name} ${node.replaces.version}\n  Uninstalling ${node.replaces.name}-${node.replaces.version}:`)
    try { uninstallDistribution(node.replaces) } catch (error) { throw new Failure(`ERROR: Could not uninstall ${node.replaces.name}: ${error instanceof Error ? error.message : String(error)}`, 1) }
    say(o, `    Successfully uninstalled ${node.replaces.name}-${node.replaces.version}`)
  }
  say(o, `Installing collected packages: ${nodes.map(node => node.name).join(', ')}`)
  for (const node of nodes) {
    const bytes = node.local ? node.local.bytes : wheels.get(node.key).bytes
    try {
      await installWheel(bytes, target, { requested: node.explicit })
    } catch (error) {
      throw new Failure(`ERROR: Could not install ${node.name} ${node.version}: ${error instanceof Error ? error.message : String(error)}`, 1)
    }
  }
  out(`Successfully installed ${nodes.map(node => `${node.name}-${node.version}`).join(' ')}`)
  return 0
}

async function uninstall(o) {
  const names = [...o.positional]
  for (const file of o.requirements) names.push(...readText(resolvePath(getcwd(), file)).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')))
  if (!names.length) throw new Failure('ERROR: You must give at least one requirement to uninstall (see "pip help uninstall")', 1)
  const have = installedMap()
  let code = 0
  for (const text of names) {
    const key = normalize(text.replace(/[<>=!~;[\s].*$/, ''))
    const distribution = have.get(key)
    if (!distribution) { err(`WARNING: Skipping ${text} as it is not installed.`); continue }
    const paths = recorded(distribution)
    const tops = [...new Set(paths.map(path => path.slice(distribution.site.length + 1).split('/')[0]).filter(top => !top.startsWith('.')))]
    out(`Found existing installation: ${distribution.name} ${distribution.version}\nUninstalling ${distribution.name}-${distribution.version}:\n  Would remove:\n${tops.map(top => `    ${join(distribution.site, top)}${paths.some(path => path.startsWith(join(distribution.site, top) + '/')) ? '/*' : ''}`).join('\n')}`)
    if (!o.yes && !confirm('Proceed (Y/n)?')) { out('Abort'); code = 1; continue }
    try {
      uninstallDistribution(distribution)
      out(`  Successfully uninstalled ${distribution.name}-${distribution.version}`)
    } catch (error) {
      err(`ERROR: Could not uninstall ${distribution.name}: ${error instanceof Error ? error.message : String(error)}`)
      code = 1
    }
  }
  return code
}

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)))
  return rows.map(row => row.map((cell, column) => String(cell).padEnd(widths[column])).join(' ').trimEnd())
}

async function list(o) {
  const distributions = [...installedMap().values()].sort((a, b) => a.key.localeCompare(b.key))
  let shown = distributions
  let latest = {}
  if (o.outdated) {
    const target = targetOf({ user: o.user })
    const index = new Index(o.index, target.cache, { offline: o.offline })
    const minor = Number(pythonVersion().split('.')[1])
    shown = []
    for (const distribution of distributions) {
      try {
        const document = await index.document(distribution.key)
        const newest = Object.keys(document.releases ?? {}).filter(version => !/(a|b|rc|dev)\d*$/.test(version) && (document.releases[version] ?? []).some(file => pureWheel(file.filename, minor))).sort(compareVersions).pop()
        if (newest && compareVersions(newest, distribution.version) > 0) { shown.push(distribution); latest[distribution.key] = newest }
      } catch { /* an index that cannot say has nothing outdated to show */ }
    }
  }
  if (o.format === 'freeze') { for (const distribution of shown) out(`${distribution.name}==${distribution.version}`); return 0 }
  if (o.format === 'json') {
    out(JSON.stringify(shown.map(distribution => ({ name: distribution.name, version: distribution.version, ...(o.outdated ? { latest_version: latest[distribution.key], latest_filetype: 'wheel' } : {}) }))))
    return 0
  }
  if (!shown.length) return 0
  const rows = o.outdated ? [['Package', 'Version', 'Latest', 'Type'], ...shown.map(d => [d.name, d.version, latest[d.key], 'wheel'])] : [['Package', 'Version'], ...shown.map(d => [d.name, d.version])]
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)))
  const lines = table(rows)
  out([lines[0], widths.map(width => '-'.repeat(width)).join(' '), ...lines.slice(1)].join('\n'))
  return 0
}

function freeze() {
  for (const distribution of [...installedMap().values()].sort((a, b) => a.key.localeCompare(b.key))) out(`${distribution.name}==${distribution.version}`)
  return 0
}

function show(o) {
  if (!o.positional.length) throw new Failure('ERROR: Please provide a package name or names.', 1)
  const have = installedMap()
  const all = [...have.values()]
  let code = 0
  let first = true
  for (const text of o.positional) {
    const distribution = have.get(normalize(text))
    if (!distribution) { err(`WARNING: Package(s) not found: ${text}`); code = 1; continue }
    const requires = (distribution.headers['Requires-Dist'] ?? []).map(text_ => { try { return parseRequirement(text_) } catch { return undefined } }).filter(Boolean)
    const direct = [...new Set(requires.filter(requirement => { try { return applies(requirement, environment(`${pythonVersion()}.0`), ['']) } catch { return false } }).map(requirement => requirement.name))]
    const requiredBy = all.filter(other => (other.headers['Requires-Dist'] ?? []).some(text_ => { try { return parseRequirement(text_).name === distribution.key && applies(parseRequirement(text_), environment(`${pythonVersion()}.0`), ['']) } catch { return false } })).map(other => other.name)
    if (!first) out('---')
    first = false
    out([
      `Name: ${distribution.name}`, `Version: ${distribution.version}`, `Summary: ${distribution.headers.Summary?.[0] ?? ''}`, `Home-page: ${distribution.headers['Home-page']?.[0] ?? ''}`,
      `Author: ${distribution.headers.Author?.[0] ?? ''}`, `Author-email: ${distribution.headers['Author-email']?.[0] ?? ''}`, `License: ${distribution.headers.License?.[0] ?? ''}`,
      `Location: ${distribution.site}`, `Requires: ${direct.join(', ')}`, `Required-by: ${requiredBy.join(', ')}`
    ].join('\n'))
    if (o.files) out(`Files:\n${recorded(distribution).map(path => `  ${path.slice(distribution.site.length + 1)}`).join('\n')}`)
  }
  return code
}

function check() {
  const have = installedMap()
  const env = environment(`${pythonVersion()}.0`)
  let broken = 0
  for (const distribution of have.values()) {
    for (const text of distribution.headers['Requires-Dist'] ?? []) {
      let requirement
      try { requirement = parseRequirement(text) } catch { continue }
      try { if (!applies(requirement, env, [''])) continue } catch { continue }
      const found = have.get(requirement.name)
      if (!found) { out(`${distribution.name} ${distribution.version} requires ${requirement.name}, which is not installed.`); broken++ }
      else if (!satisfies(found.version, requirement.specifier, { prereleases: true })) { out(`${distribution.name} ${distribution.version} has requirement ${requirement.name}${formatSpecifier(requirement.specifier)}, but you have ${found.name} ${found.version}.`); broken++ }
    }
  }
  if (!broken) out('No broken requirements found.')
  return broken ? 1 : 0
}

async function indexVersions(o) {
  if (o.positional[0] !== 'versions' || !o.positional[1]) throw new Failure('ERROR: Usage: pip index versions <package>', 1)
  const target = targetOf({ user: o.user })
  const index = new Index(o.index, target.cache, { offline: o.offline })
  const name = normalize(o.positional[1])
  let document
  try { document = await index.document(name) } catch (error) { throw new Failure(`ERROR: No matching distribution found for ${o.positional[1]}\n${error instanceof Error ? error.message : String(error)}`, 1) }
  const versions = Object.keys(document.releases ?? {}).sort((a, b) => compareVersions(b, a))
  const have = installedMap().get(name)
  out(`${document.info.name} (${versions[0]})\nAvailable versions: ${versions.join(', ')}${have ? `\n  INSTALLED: ${have.version}` : ''}\n  LATEST:    ${versions[0]}`)
  return 0
}

function cache(o) {
  const target = targetOf({ user: o.user })
  const directory = join(target.cache, 'pip')
  const action = o.positional[0]
  if (action === 'dir') { out(directory); return 0 }
  if (action === 'purge') { try { rmRecursive(directory) } catch { /* empty already */ } out('Files removed: all'); return 0 }
  if (action === 'info') { out(`Package index page cache location: ${join(directory, 'meta')}\nWheels location: ${join(directory, 'wheels')}`); return 0 }
  throw new Failure('ERROR: Usage: pip cache dir|info|purge', 1)
}

function config(o) {
  if (o.positional[0] === 'list' || !o.positional[0]) {
    out(`global.index-url='${new Index(o.index, '/tmp').url}/simple'`)
    return 0
  }
  throw new Failure('ERROR: Only "pip config list" is supported on ecmaOS; pass --index-url or set PIP_INDEX_URL', 1)
}

export async function run(tool, args) {
  try {
    const o = parse(args)
    const verb = o.positional.shift()
    if (o.version) { out(`pip ${VERSION} from ${targetOf({ user: false }).site}/pip (python ${pythonVersion()})`); return 0 }
    if (o.help || !verb || verb === 'help') { out(usage); return verb || o.help ? 0 : 1 }
    if (o.unknown) throw new Failure(`${tool}: error: no such option: ${o.unknown}`, 2)
    switch (verb) {
      case 'install': return await install(o)
      case 'uninstall': return await uninstall(o)
      case 'list': return await list(o)
      case 'freeze': return freeze()
      case 'show': return show(o)
      case 'check': return check()
      case 'index': return await indexVersions(o)
      case 'cache': return cache(o)
      case 'config': return config(o)
      case 'search': throw new Failure("ERROR: XMLRPC request failed [code: -32500]\nRuntimeError: PyPI no longer supports 'pip search' (or XML-RPC search). Please use https://pypi.org/search (via a browser) instead.", 1)
      case 'download': case 'wheel': case 'hash': case 'inspect': case 'debug': case 'completion':
        throw new Failure(`ERROR: pip ${verb} is not available on ecmaOS`, 1)
    }
    throw new Failure(`ERROR: unknown command "${verb}"`, 1)
  } catch (error) {
    if (error instanceof Failure) { if (error.message) err(error.message); return error.code }
    err(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

export { sitesOf }
