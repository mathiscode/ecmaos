#!/usr/bin/env node
/**
 * `pnpm test:group <name> [vitest options]`: one family of test files. Corpus files are included, since a group is
 * something run on purpose. `pnpm test:group` alone lists the groups.
 */

import { spawnSync } from 'node:child_process'

const groups = {
  shell: ['tests/tree/shell', 'tests/tree/ecmash', 'tests/tree/terminal', 'tests/tree/tty-input', 'tests/tree/heredoc', 'tests/tree/job'],
  posix: ['tests/tree/posix-fileops'],
  'gnu-tools': ['tests/tree/gnu-tools'],
  'gnu-coreutils': ['tests/tree/gnu-coreutils'],
  parity: ['tests/tree/shell-parity'],
  commands: ['tests/tree/text-commands', 'tests/tree/command-batch', 'tests/tree/execve-commands', 'tests/tree/kernel-execve-commands', 'tests/tree/tier-c'],
  wasi: ['tests/tree/wasi'],
  accounts: ['tests/tree/accounts', 'tests/tree/su-sudo', 'tests/tree/process-credentials', 'tests/tree/users', 'tests/tree/shadow', 'tests/tree/cron'],
  boot: ['tests/tree/init', 'tests/tree/getty', 'tests/tree/boot', 'tests/tree/kernel.test', 'tests/tree/fs-migration', 'tests/tree/filesystem'],
  slow: ['slow']
}

const [name, ...rest] = process.argv.slice(2)
if (!name || !groups[name]) {
  console.log(`${name ? `unknown group "${name}"\n` : ''}groups: ${Object.keys(groups).join(', ')}`)
  process.exit(name ? 1 : 0)
}

const result = spawnSync('npx', ['vitest', 'run', ...groups[name], ...rest], { stdio: 'inherit', env: { ...process.env, CORPUS: '1', SLOW: name === 'slow' ? '1' : '' } })
process.exit(result.status ?? 1)
