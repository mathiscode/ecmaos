#!/usr/bin/env node
/**
 * Fails when a dependency is under a license that is not on scripts/license-allowlist.json.
 *
 * Reads `pnpm licenses list --json` (every package in the lockfile, development ones too). An SPDX expression passes
 * when each AND operand does and at least one OR alternative does; WITH exceptions are ignored. A copyleft license is
 * allowed only for the packages `reviewed` names, so a new LGPL or MPL dependency is a decision, not an accident.
 *
 *   node scripts/check-licenses.mjs          check, listing what does not pass
 *   node scripts/check-licenses.mjs --list   print every license in use and how many packages hold it
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const policy = JSON.parse(readFileSync(path.join(import.meta.dirname, 'license-allowlist.json'), 'utf8'))
const allowed = new Set(policy.allowed)
const matches = (name, pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern)

const listing = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }))

if (process.argv.includes('--list')) {
  for (const [license, packages] of Object.entries(listing).sort((a, b) => b[1].length - a[1].length)) console.log(String(packages.length).padStart(5), license)
  process.exit(0)
}

/** Parses an SPDX expression into { op, items } / a license id, and says whether `ok(id)` holds for it */
function evaluate(expression, ok) {
  const tokens = expression.replace(/[()]/g, match => ` ${match} `).split(/\s+/).filter(Boolean)
  let at = 0
  const primary = () => {
    const token = tokens[at++]
    if (token === '(') { const value = or(); at++; return value }
    let id = policy.normalize?.[token] ?? token
    if (tokens[at] === 'WITH') at += 2
    return ok(id)
  }
  const and = () => { let value = primary(); while (tokens[at] === 'AND') { at++; value = primary() && value } return value }
  const or = () => { let value = and(); while (tokens[at] === 'OR') { at++; value = and() || value } return value }
  return or()
}

const failures = []
for (const [license, packages] of Object.entries(listing)) {
  for (const pkg of packages) {
    const name = pkg.name
    if (policy.exceptions?.[name]) continue
    const normalized = policy.normalize?.[license] ?? license
    const pass = evaluate(normalized, id => {
      if (allowed.has(id)) return true
      const review = policy.reviewed?.[id]
      return Boolean(review?.packages?.some(pattern => matches(name, pattern)))
    })
    if (!pass) failures.push(`${name}@${pkg.versions.join(',')}  ${license}`)
  }
}

if (failures.length) {
  console.error(`check:licenses: ${failures.length} package(s) under a license that is not allowed:\n  ${failures.sort().join('\n  ')}\n` +
    'Review the license, then add it to scripts/license-allowlist.json (allowed, reviewed for these packages, or an exception with the reason).')
  process.exit(1)
}
console.log(`check:licenses: every dependency is under an allowed license (${Object.values(listing).flat().length} packages)`)
