/**
 * Regenerates gnu-coreutils.golden.json by running each corpus command with the real GNU tools:
 *   node core/kernel/tests/tree/fixtures/generate-gnu-coreutils.mjs
 * Needs GNU coreutils and bash on the machine. Output is stored as latin1 strings (one char per byte).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { buffers, cases } from './gnu-coreutils.corpus.mjs'

const dir = mkdtempSync(join(tmpdir(), 'gnu-coreutils-'))
for (const [name, data] of Object.entries(buffers)) writeFileSync(join(dir, name), data)
mkdirSync(join(dir, 'dir'))

const golden = cases.map(cmd => {
  const result = spawnSync('bash', ['-c', cmd], { cwd: dir, env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' } })
  return { cmd, out: result.stdout.toString('latin1'), code: result.status ?? -1, err: result.stderr.toString('latin1') }
})

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gnu-coreutils.golden.json'), JSON.stringify(golden, null, 1))
console.log(`${golden.length} commands`)
