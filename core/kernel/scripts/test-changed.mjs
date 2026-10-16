#!/usr/bin/env node
/**
 * `pnpm test:changed [base]`: the tests that the changes since `base` (default HEAD, so the working tree) can break.
 *
 * - Every test whose imports lead to a changed file (vitest's `--changed`).
 * - The corpus cases for the commands that changed: a change to commands-execve/awk.mjs runs the awk cases of the GNU
 *   corpora and of the shell parity corpus, not all of them. A change to anything else in core/utils or to the kernel
 *   cannot be narrowed to a command, so it adds nothing; run `pnpm test:corpus` when that is the worry.
 */

import { execFileSync, spawnSync } from 'node:child_process'

const base = process.argv[2] ?? 'HEAD'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)

const changed = new Set([...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')])
const commands = [...changed]
  .map(file => /^core\/utils\/src\/commands-execve\/([\w-]+)\.mjs$/.exec(file)?.[1])
  .filter(Boolean)

const run = (args, env = {}) => spawnSync('npx', ['vitest', 'run', ...args], { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1

let status = run(['--changed', base, '--passWithNoTests'])

if (commands.length) {
  // the command name where a command can start: at the start of a line, or after a space, ; | & ( { ` or $(
  const filter = `(^|[\\s;|&(\`{])(${commands.join('|')})(\\s|$|;|\\))`
  console.log(`\ncorpus cases for: ${commands.join(', ')}`)
  status = run(['gnu-tools', 'gnu-coreutils', 'shell-parity'], { CORPUS: '1', CORPUS_FILTER: filter }) || status
}

process.exit(status)
