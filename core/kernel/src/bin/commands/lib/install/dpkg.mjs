/**
 * `dpkg` over `install`'s engine: what is installed, its files and its owners, installing a local package, removing.
 * Names are Debian's (the index maps them to npm packages); a `.deb` is not a thing here, a package is an npm `.tgz`.
 */

import { resolve } from '../path-utils.mjs'
import { exists } from './io.mjs'
import {
  Failure, descriptionOf, dependsOf, displayName, err, installed, manifestOf, openSession, out, ownedPaths, ownerOf, sizeOf, directoryOf, translate
} from './frontend.mjs'

const { getcwd } = globalThis.ecmaosSyscalls

const usage = `Usage: dpkg [OPTION...] COMMAND

Commands:
  -i, --install FILE.tgz...    install a package from a local npm tarball
  -r, --remove PACKAGE...      remove packages
  -P, --purge PACKAGE...       remove packages (the same here)
  -l, --list [PATTERN...]      list installed packages
  -L, --listfiles PACKAGE...   list the files a package put in place
  -s, --status PACKAGE...      show a package's status
  -S, --search PATH...         find the package a file belongs to
  -W, --show [PATTERN...]      show NAME and VERSION of installed packages
      --get-selections         list installed packages as 'NAME install'
      --version                show the version

Options:
      --registry=URL   npm registry to use for dependencies
      --user           work on your own packages (~/.local), even as root`

function parse(args) {
  const o = { operands: [] }
  const commands = { '-i': 'install', '--install': 'install', '-r': 'remove', '--remove': 'remove', '-P': 'purge', '--purge': 'purge', '-l': 'list', '--list': 'list', '-L': 'files', '--listfiles': 'files', '-s': 'status', '--status': 'status', '-S': 'search', '--search': 'search', '-W': 'show', '--show': 'show', '--get-selections': 'selections' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { o.operands.push(...args.slice(i + 1)); break }
    if (commands[arg]) { o.command = commands[arg]; continue }
    if (arg === '--version') { o.version = true; continue }
    if (arg === '-h' || arg === '--help' || arg === '-?') { o.help = true; continue }
    if (arg === '--registry') { o.registry = args[++i]; continue }
    if (arg.startsWith('--registry=')) { o.registry = arg.slice(11); continue }
    if (arg === '--user') { o.user = true; continue }
    if (arg === '--offline') { o.offline = true; continue }
    if (/^--(force|no-force|refuse|ignore-depends|skip-same-version|no-triggers|simulate|root|admindir|instdir)/.test(arg) || arg === '--no-act') continue
    if (arg.startsWith('-') && arg.length > 1) throw new Failure(`dpkg: error: unknown option ${arg}\n\nType dpkg --help for help about installing and deinstalling packages.`, 2)
    o.operands.push(arg)
  }
  return o
}

const pad = (text, width) => String(text).padEnd(width)

/** A shell-style `*` pattern (as dpkg takes) as a test on a name; plain text matches exactly */
function matcher(pattern) {
  const expression = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return name => expression.test(name)
}

function rows(session, patterns) {
  const tests = patterns.map(matcher)
  return installed(session)
    .map(row => ({ ...row, name: displayName(session, 'apt', row.entry) }))
    .filter(row => !tests.length || tests.some(test => test(row.name)))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function list(session, o) {
  const found = rows(session, o.operands)
  if (!found.length) {
    for (const pattern of o.operands) err(`dpkg-query: no packages found matching ${pattern}`)
    return 1
  }
  const nameWidth = Math.max(14, ...found.map(row => row.name.length))
  const versionWidth = Math.max(12, ...found.map(row => row.entry.version.length))
  out(`Desired=Unknown/Install/Remove/Purge/Hold
| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend
|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)
||/ ${pad('Name', nameWidth)} ${pad('Version', versionWidth)} ${pad('Architecture', 12)} Description
+++-${'='.repeat(nameWidth)}-${'='.repeat(versionWidth)}-${'='.repeat(12)}-${'='.repeat(40)}`)
  for (const row of found) out(`ii  ${pad(row.name, nameWidth)} ${pad(row.entry.version, versionWidth)} ${pad('all', 12)} ${descriptionOf(row.scope, row.entry).slice(0, 60)}`)
  return 0
}

function files(session, o) {
  if (!o.operands.length) throw new Failure('dpkg: error: --listfiles needs a valid package name but \'\' is not: ambiguous package name \'\' with more than one installed version', 2)
  let code = 0
  for (const operand of o.operands) {
    const row = rows(session, [operand]).find(row => row.name === operand) ?? rows(session, []).find(row => row.entry.name === operand)
    if (!row) { err(`dpkg-query: package '${operand}' is not installed`); code = 1; continue }
    out('/.')
    for (const path of ownedPaths(row.scope, row.entry)) out(path)
  }
  return code
}

function status(session, o) {
  if (!o.operands.length) throw new Failure('dpkg: error: --status needs a valid package name', 2)
  let code = 0
  for (const operand of o.operands) {
    const row = rows(session, [operand]).find(row => row.name === operand) ?? rows(session, []).find(row => row.entry.name === operand)
    if (!row) { err(`dpkg-query: package '${operand}' is not installed and no information is available`); code = 1; continue }
    const manifest = manifestOf(row.scope, row.entry)
    const maintainer = manifest.author ? (typeof manifest.author === 'string' ? manifest.author : `${manifest.author.name}${manifest.author.email ? ` <${manifest.author.email}>` : ''}`) : undefined
    const depends = dependsOf(manifest, session, 'apt')
    out([
      `Package: ${row.name}`,
      `Status: install ok installed`,
      'Priority: optional',
      'Section: node',
      `Installed-Size: ${Math.max(1, Math.round(sizeOf(directoryOf(row.scope, row.entry)) / 1024))}`,
      ...(maintainer ? [`Maintainer: ${maintainer}`] : []),
      'Architecture: all',
      `Version: ${row.entry.version}`,
      ...(depends.length ? [`Depends: ${depends.join(', ')}`] : []),
      ...(manifest.homepage ? [`Homepage: ${manifest.homepage}`] : []),
      `Description: ${descriptionOf(row.scope, row.entry) || 'no description'}`,
      ...(row.entry.explicit ? [] : ['Auto-Installed: yes']),
      `Npm-Package: ${row.entry.name}`,
      ''
    ].join('\n'))
  }
  return code
}

function search(session, o) {
  if (!o.operands.length) throw new Failure('dpkg: error: --search needs at least one file name pattern argument', 2)
  let code = 0
  for (const operand of o.operands) {
    const path = resolve(getcwd(), operand)
    const owner = ownerOf(session, path)
    if (!owner) { err(`dpkg-query: no path found matching pattern ${operand}`); code = 1; continue }
    out(`${displayName(session, 'apt', owner.entry)}: ${path}`)
  }
  return code
}

async function install(session, o) {
  if (!o.operands.length) throw new Failure('dpkg: error: --install needs at least one package archive file argument', 2)
  const requests = []
  for (const operand of o.operands) {
    const path = resolve(getcwd(), operand)
    if (/\.deb$/.test(operand)) throw new Failure(`dpkg: error: ${operand}: ecmaOS packages are npm tarballs (.tgz); a .deb cannot be installed here`, 2)
    if (!exists(path)) throw new Failure(`dpkg: error: cannot access archive '${operand}': No such file or directory`, 2)
    requests.push({ name: path, local: await session.engine.local(path) })
  }
  const plan = await session.engine.resolve(requests)
  session.engine.options.placed = node => {
    out(`Selecting previously unselected package ${displayName(session, 'apt', node)}.`)
    out(`Unpacking ${displayName(session, 'apt', node)} (${node.version}) ...`)
    out(`Setting up ${displayName(session, 'apt', node)} (${node.version}) ...`)
  }
  return await session.engine.apply(plan) ? 2 : 0
}

async function remove(session, o) {
  if (!o.operands.length) throw new Failure(`dpkg: error: --${o.command} needs at least one package name argument`, 2)
  const names = []
  for (const operand of o.operands) {
    const found = translate(session, 'apt', [operand])
    const target = found.requests[0]?.name ?? (session.db.versionsOf(operand).length ? operand : undefined)
    if (!target || !session.db.versionsOf(target).length) { err(`dpkg: warning: ignoring request to remove ${operand} which isn't installed`); continue }
    names.push(target)
  }
  if (!names.length) return 0
  for (const name of names) for (const entry of session.db.versionsOf(name)) out(`Removing ${displayName(session, 'apt', entry)} (${entry.version}) ...`)
  return await session.engine.remove(names) ? 2 : 0
}

function show(session, o) {
  const found = rows(session, o.operands)
  if (!found.length) {
    for (const pattern of o.operands) err(`dpkg-query: no packages found matching ${pattern}`)
    return 1
  }
  for (const row of found) out(`${row.name}\t${row.entry.version}`)
  return 0
}

function selections(session, o) {
  for (const row of rows(session, o.operands)) out(`${pad(row.name, 40)}install`)
  return 0
}

export async function run(args) {
  try {
    const o = parse(args)
    if (o.version) { out('Debian dpkg package management program version 1.22 (ecmaOS, on npm\'s registry).'); return 0 }
    if (o.help || !o.command) { out(usage); return o.help ? 0 : 2 }
    const session = openSession(o)
    switch (o.command) {
      case 'list': return list(session, o)
      case 'files': return files(session, o)
      case 'status': return status(session, o)
      case 'search': return search(session, o)
      case 'install': return await install(session, o)
      case 'remove': case 'purge': return await remove(session, o)
      case 'show': return show(session, o)
      case 'selections': return selections(session, o)
    }
    return 0
  } catch (error) {
    if (error instanceof Failure) { if (error.message) err(error.message); return error.code }
    err(`dpkg: error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}
