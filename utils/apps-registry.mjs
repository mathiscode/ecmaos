#!/usr/bin/env node
// A local npm registry (Verdaccio) for trying ecmaOS's packages before anything reaches npmjs: the WebAssembly programs
// as @ecmaos-apps/* (with the -src package of each copyleft one) and @ecmaos/package-index. Nothing here publishes to
// npmjs; the registry is http://localhost:4893 (ECMAOS_REGISTRY_PORT) and its files are in .registry/ (ignored by git).
//
//   node utils/apps-registry.mjs up                      start it in the background (fetches Verdaccio with npx the first time)
//   node utils/apps-registry.mjs down                    stop it
//   node utils/apps-registry.mjs status                  whether it answers, and what it holds
//   node utils/apps-registry.mjs publish [name...]       build the programs' packages (all if none) and publish them, each
//                                                        source package first; with no names the groups and profiles too,
//                                                        then the signed index (signed with a key of this registry's own,
//                                                        .registry/dev-signing.pem) and the package index
//   node utils/apps-registry.mjs reset                   stop it and forget everything it held
//
// Then point ecmaOS at it: `REGISTRY=http://localhost:4893` in the kernel's environment, or `--registry` on a command.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { keygen, publicOf, signTrust, trustOf } from './apps-sign.mjs'
import { publishedNames } from './apps-sign.mjs'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, '.registry')
const port = Number(process.env['ECMAOS_REGISTRY_PORT'] || 4893)
export const URL_ = `http://localhost:${port}`
const VERDACCIO = 'verdaccio@6.1.6'
const pidFile = path.join(home, 'verdaccio.pid')

const ping = async () => {
  try { return (await fetch(`${URL_}/-/ping`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false }
}

async function up() {
  if (await ping()) { console.log(`already running at ${URL_}`); return }
  mkdirSync(home, { recursive: true })
  copyFileSync(path.join(import.meta.dirname, 'registry/config.yaml'), path.join(home, 'config.yaml'))
  const log = openSync(path.join(home, 'verdaccio.log'), 'a')
  const child = spawn('npx', ['--yes', VERDACCIO, '--config', path.join(home, 'config.yaml'), '--listen', String(port)], { cwd: home, detached: true, stdio: ['ignore', log, log] })
  child.unref()
  writeFileSync(pidFile, String(child.pid))
  for (let i = 0; i < 120; i++) {
    if (await ping()) { console.log(`running at ${URL_} (log: .registry/verdaccio.log)`); return }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`the registry did not answer; see .registry/verdaccio.log`)
}

function down() {
  if (!existsSync(pidFile)) { console.log('not started by this script'); return }
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try { process.kill(-pid) } catch { try { process.kill(pid) } catch { /* gone */ } }
  rmSync(pidFile, { force: true })
  console.log('stopped')
}

async function status() {
  if (!await ping()) { console.log(`not running at ${URL_}`); return }
  const found = await (await fetch(`${URL_}/-/verdaccio/data/packages`)).json().catch(() => [])
  console.log(`running at ${URL_}: ${found.length} packages${found.length ? `\n  ${found.map(entry => `${entry.name}@${entry.version}`).join('\n  ')}` : ''}`)
}

/** Publishes the directory with npm; the token is a placeholder, since this registry lets anyone publish its own scopes */
function publishDirectory(directory) {
  const host = URL_.replace(/^https?:/, '')
  execFileSync('npm', ['publish', directory, '--loglevel', 'error', '--registry', URL_, `--${host}/:_authToken=local`, '--access', 'public', '--tag', 'latest'], { stdio: ['ignore', 'ignore', 'inherit'] })
}

/**
 * Signs what this registry holds under `@ecmaos-apps` with the registry's own key, which it makes the first time, and
 * leaves the entry to trust it in `.registry/trusted-keys.json` (`/etc/ecmaos/trusted-keys.json` on a machine that
 * should accept this registry's packages without `--allow-unsigned`)
 */
async function signIndex() {
  const keyFile = path.join(home, 'dev-signing.pem')
  const entry = existsSync(keyFile) ? publicOf(keyFile) : keygen(keyFile)
  const documents = {}
  for (const name of publishedNames()) {
    const response = await fetch(`${URL_}/${name}`)
    if (response.ok) documents[name] = await response.json()
  }
  const trust = trustOf(documents)
  const { text, signature } = signTrust(trust, keyFile)
  writeFileSync(path.join(root, 'utils/package-index/trust.json'), text)
  writeFileSync(path.join(root, 'utils/package-index/trust.sig.json'), JSON.stringify(signature, null, 2) + '\n')
  writeFileSync(path.join(home, 'trusted-keys.json'), JSON.stringify([entry], null, 2) + '\n')
  console.log(`signed ${Object.keys(trust.packages).length} packages (trust this registry with .registry/trusted-keys.json)`)
}

async function publish(names) {
  if (!await ping()) throw new Error(`the registry is not running at ${URL_} (node utils/apps-registry.mjs up)`)
  const out = mkdtempSync(path.join(tmpdir(), 'ecmaos-apps-'))
  try {
    // `group-NAME` and `profile-NAME` name the meta-packages; they go with a full run too
    const isGroup = name => /^(group|profile)-/.test(name)
    const programNames = names.filter(name => !isGroup(name))
    if (!names.length || programNames.length) execFileSync('node', [path.join(import.meta.dirname, 'apps-packages.mjs'), 'build', out, ...programNames], { stdio: ['ignore', 'ignore', 'inherit'] })
    if (!names.length || names.some(isGroup)) execFileSync('node', [path.join(import.meta.dirname, 'apps-packages.mjs'), 'groups', out], { stdio: ['ignore', 'ignore', 'inherit'] })
    const directories = readdirSync(out).filter(directory => !names.some(isGroup) || programNames.length || names.includes(directory))
    // a copyleft program's source goes up before its binary: the binary never exists without it
    const rank = directory => (directory.endsWith('-src') ? 0 : /^(group|profile)-/.test(directory) ? 2 : 1)
    for (const directory of directories.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      publishDirectory(path.join(out, directory))
      console.log(`published @ecmaos-apps/${directory}`)
    }
    if (!names.length) await signIndex()
    // the index keeps its version until it is bumped for a release; a registry that already has it is not an error
    try {
      publishDirectory(path.join(root, 'utils/package-index'))
      console.log('published @ecmaos/package-index')
    } catch {
      console.log('@ecmaos/package-index: this version is already published (bump utils/package-index/package.json to publish a changed index)')
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === 'up') await up()
  else if (command === 'down') down()
  else if (command === 'status') await status()
  else if (command === 'publish') await publish(rest)
  else if (command === 'reset') { down(); rmSync(path.join(home, 'storage'), { recursive: true, force: true }); rmSync(path.join(home, 'htpasswd'), { force: true }); console.log('forgot everything') }
  else throw new Error('usage: apps-registry.mjs up | down | status | publish [name...] | reset')
} catch (error) {
  console.error(`apps-registry: ${error.message}`)
  process.exit(1)
}
