#!/usr/bin/env node
/**
 * Fails when a commit in a range has no `Signed-off-by:` line: the Developer Certificate of Origin
 * (https://developercertificate.org/) that CONTRIBUTING.md asks of every contribution. `git commit -s` adds the line.
 * Merge commits, bots (Dependabot) and the maintainers in `exempt` are skipped.
 *
 *   node scripts/check-dco.mjs <base>..<head>     e.g. origin/main..HEAD (CI passes the pull request's range)
 */
import { execFileSync } from 'node:child_process'

const range = process.argv[2]
if (!range) {
  console.error('usage: check-dco.mjs <base>..<head>')
  process.exit(2)
}

const log = execFileSync('git', ['log', '--no-merges', '--format=%H%x1f%an%x1f%ae%x1f%B%x1e', range], { encoding: 'utf8', maxBuffer: 1 << 28 })
// Maintainers who own the project's copyright, matched by author email; remove an entry to ask them for a sign-off too
const exempt = new Set(['code@mathis.network'])
const bots = /\[bot\]$|noreply\.github\.com$/i
const trailer = /^Signed-off-by: .+ <.+@.+>\s*$/m

const missing = []
let checked = 0
for (const record of log.split('\x1e').map(entry => entry.trim()).filter(Boolean)) {
  const [hash, name, email, message] = record.split('\x1f')
  if (exempt.has(email.toLowerCase()) || bots.test(name) || (bots.test(email) && /bot/i.test(name))) continue
  checked++
  if (!trailer.test(message)) missing.push(`${hash.slice(0, 10)} ${name} <${email}>: ${message.split('\n')[0].slice(0, 80)}`)
}

if (missing.length) {
  console.error(`check:dco: ${missing.length} commit(s) without a Signed-off-by line:\n  ${missing.join('\n  ')}\n` +
    'Add one with `git commit -s --amend` (or `git rebase --signoff <base>` for several): it certifies the Developer Certificate of Origin, https://developercertificate.org/')
  process.exit(1)
}
console.log(`check:dco: ${checked} commit(s) in ${range}, each signed off`)
