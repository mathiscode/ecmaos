/**
 * Python's own record of what is installed: `site-packages` and its `NAME-VERSION.dist-info` directories (METADATA,
 * RECORD, INSTALLER, REQUESTED), the one convention pip, `importlib.metadata` and every Python tool share. Installing a
 * wheel unpacks it the way pip does (`purelib`/`platlib` into site-packages, `scripts` into the bin directory with their
 * shebang fixed, `entry_points.txt` console scripts written out) and writes the `dist-info` records; uninstalling reads
 * RECORD back.
 */

import { join } from '../path-utils.mjs'
import { dirname, exists, mkdirp, names, readText, writeBytes } from '../install/io.mjs'
import { entriesOf, read } from './zip.mjs'
import { normalize } from './pep440.mjs'

const { env, geteuid, unlink, rmdir, rmRecursive, isDirectory, chmod } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()

/** The Python minor version installed (`3.14` from `/usr/lib/python3.14`), else the one ecmaOS ships */
export function pythonVersion() {
  try {
    const found = names('/usr/lib').map(name => /^python(3\.\d+)$/.exec(name)?.[1]).filter(Boolean).sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]))
    if (found.length) return found[0]
  } catch { /* no /usr/lib */ }
  return '3.14'
}

/** The places packages go: the system's site-packages for root, else the user's (`~/.local`, which Python's `site` adds) */
export function targetOf({ user = false } = {}) {
  const version = pythonVersion()
  const home = env['HOME'] || '/root'
  const system = geteuid() === 0 && !user
  const prefix = system ? '/usr' : join(home, '.local')
  return { system, version, prefix, site: `${prefix}/lib/python${version}/site-packages`, bin: `${prefix}/bin`, cache: system ? '/var/cache/install' : join(home, '.cache/install') }
}

/** Every site directory pip reads: the user's and the system's */
export const sitesOf = () => [targetOf({ user: true }), targetOf({ user: false })].map(target => target.site).filter((site, index, all) => all.indexOf(site) === index)

/** A `Key: value` header block (METADATA) as `{ key: [values] }`, stopping at the body */
export function parseHeaders(text) {
  const headers = {}
  const [head] = text.split(/\r?\n\r?\n/)
  let last
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && last) { headers[last][headers[last].length - 1] += `\n${line.trim()}`; continue }
    const at = line.indexOf(':')
    if (at < 0) continue
    last = line.slice(0, at).trim()
    ;(headers[last] ??= []).push(line.slice(at + 1).trim())
  }
  return headers
}

/** The distributions in the site directories: `[{ name, key, version, dir, site, requested, headers }]` */
export function installed(sites = sitesOf()) {
  const found = []
  for (const site of sites) {
    let entries
    try { entries = names(site) } catch { continue }
    for (const entry of entries) {
      const match = /^(.+?)-(\d[^-]*?)\.(dist-info|egg-info)$/.exec(entry)
      if (!match) continue
      const dir = join(site, entry)
      let headers = {}
      try { headers = parseHeaders(readText(match[3] === 'dist-info' ? join(dir, 'METADATA') : (isDirectory(dir) ? join(dir, 'PKG-INFO') : dir))) } catch { /* no metadata */ }
      const name = headers.Name?.[0] ?? match[1]
      found.push({ name, key: normalize(name), version: headers.Version?.[0] ?? match[2], dir, site, requested: exists(join(dir, 'REQUESTED')), egg: match[3] === 'egg-info', headers })
    }
  }
  return found
}

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function recordLine(path, bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `${path},sha256=${base64url(digest)},${bytes.length}`
}

const relativeTo = (from, to) => {
  const a = from.split('/').filter(Boolean)
  const b = to.split('/').filter(Boolean)
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
  return [...a.slice(shared).map(() => '..'), ...b.slice(shared)].join('/')
}

/** `#!python` and `#!pythonw` in a wheel's script become the interpreter ecmaOS has */
function fixShebang(bytes) {
  const text = new TextDecoder().decode(bytes.subarray(0, 200))
  if (!/^#!\s*(?:\/\S*\/)?pythonw?[\d.]*(\s|$)/.test(text)) return bytes
  const lineEnd = bytes.indexOf(10)
  return new Uint8Array([...encoder.encode('#!/usr/bin/env python3'), ...bytes.subarray(lineEnd < 0 ? bytes.length : lineEnd)])
}

function entryPoints(text) {
  const result = { console_scripts: {}, gui_scripts: {} }
  let section
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) { section = header[1]; continue }
    if (!result[section]) continue
    const match = /^([^=\s]+)\s*=\s*([\w.]+)(?::([\w.]+))?/.exec(line)
    if (match && match[3]) result[section][match[1]] = [match[2], match[3]]
  }
  return result
}

const wrapper = ([module, attribute]) => `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re
import sys
from ${module} import ${attribute.split('.')[0]}
if __name__ == '__main__':
    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])
    sys.exit(${attribute}())
`

/**
 * Installs the wheel `bytes` into `target`; gives `{ name, version, files }`. `requested` marks a package asked for by name
 * (`REQUESTED`), as pip does. The wheel is read and checked whole before anything is written.
 */
export async function installWheel(bytes, target, { requested = true } = {}) {
  const entries = entriesOf(bytes)
  const infoDir = entries.map(entry => /^([^/]+\.dist-info)\//.exec(entry.name)?.[1]).find(Boolean)
  if (!infoDir) throw new Error('the wheel has no .dist-info directory')
  const stem = infoDir.slice(0, -'.dist-info'.length)
  const dataDir = `${stem}.data`
  const files = []
  for (const entry of entries) {
    if (entry.directory) continue
    const data = await read(bytes, entry)
    let path
    let mode = entry.mode & 0o111 ? 0o755 : 0o644
    const dataMatch = entry.name.startsWith(`${dataDir}/`) ? entry.name.slice(dataDir.length + 1).split('/') : undefined
    if (dataMatch) {
      const [kind, ...rest] = dataMatch
      const sub = rest.join('/')
      if (kind === 'purelib' || kind === 'platlib') path = join(target.site, sub)
      else if (kind === 'scripts') { path = join(target.bin, sub); mode = 0o755 }
      else if (kind === 'headers') path = join(target.prefix, 'include', `python${target.version}`, stem.split('-')[0], sub)
      else if (kind === 'data') path = join(target.prefix, sub)
      else path = join(target.site, entry.name)
    } else {
      path = join(target.site, entry.name)
    }
    if (!path.startsWith('/') || path.includes('..')) throw new Error(`${entry.name}: refuses to write outside the install directories`)
    files.push({ path, data: dataMatch?.[0] === 'scripts' ? fixShebang(data) : data, mode })
  }
  const metadataEntry = entries.find(entry => entry.name === `${infoDir}/METADATA`)
  if (!metadataEntry) throw new Error('the wheel has no METADATA')
  const metadata = parseHeaders(new TextDecoder().decode(await read(bytes, metadataEntry)))
  const name = metadata.Name?.[0] ?? stem.split('-')[0]
  const version = metadata.Version?.[0] ?? stem.split('-').slice(1).join('-')
  const points = entries.find(entry => entry.name === `${infoDir}/entry_points.txt`)
  const scripts = points ? entryPoints(new TextDecoder().decode(await read(bytes, points))) : { console_scripts: {}, gui_scripts: {} }
  for (const [script, target_] of [...Object.entries(scripts.console_scripts), ...Object.entries(scripts.gui_scripts)]) {
    files.push({ path: join(target.bin, script), data: encoder.encode(wrapper(target_)), mode: 0o755 })
  }
  const distInfo = join(target.site, infoDir)
  for (const extra of ['INSTALLER', ...(requested ? ['REQUESTED'] : [])]) files.push({ path: join(distInfo, extra), data: encoder.encode(extra === 'INSTALLER' ? 'pip\n' : ''), mode: 0o644 })
  // RECORD lists every file with its hash, and itself without one; files outside site-packages are relative to it
  const record = []
  for (const file of files.filter(file => !file.path.endsWith(`${infoDir}/RECORD`))) record.push(await recordLine(relativeTo(target.site, file.path), file.data))
  record.push(`${infoDir}/RECORD,,`)
  files.push({ path: join(distInfo, 'RECORD'), data: encoder.encode(record.join('\n') + '\n'), mode: 0o644 })
  const unique = new Map(files.map(file => [file.path, file]))
  for (const file of unique.values()) {
    mkdirp(dirname(file.path))
    writeBytes(file.path, file.data, file.mode)
    if (file.mode & 0o111) try { chmod(file.path, file.mode) } catch { /* the mode was set when it was made */ }
  }
  return { name, version, files: [...unique.keys()] }
}

/** The paths a distribution's RECORD lists, as absolute paths */
export function recorded(distribution) {
  const path = join(distribution.dir, 'RECORD')
  if (!exists(path)) return []
  return readText(path).split(/\r?\n/).filter(Boolean).map(line => join(distribution.site, line.split(',')[0]))
}

/** Removes a distribution: every file its RECORD lists, the directories that empties, its `__pycache__`, its `dist-info` */
export function uninstallDistribution(distribution) {
  const removed = []
  const dirs = new Set()
  for (const path of recorded(distribution)) {
    try { unlink(path); removed.push(path) } catch { continue }
    dirs.add(dirname(path))
  }
  const prune = dir => {
    for (let path = dir; path.length > 1 && path !== distribution.site && path.startsWith(distribution.site + '/'); path = dirname(path)) {
      try {
        const rest = names(path)
        // bytecode compiled from a module that is gone has nothing to run for
        if (rest.every(entry => entry === '__pycache__')) { if (rest.length) rmRecursive(join(path, '__pycache__')); rmdir(path) } else return
      } catch { return }
    }
  }
  for (const dir of dirs) prune(dir)
  try { rmRecursive(distribution.dir) } catch { /* removed with its records */ }
  return removed
}
