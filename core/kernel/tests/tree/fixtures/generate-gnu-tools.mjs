/**
 * Regenerates gnu-tools.golden.json by running each corpus command with the real tools:
 *   node core/kernel/tests/tree/fixtures/generate-gnu-tools.mjs
 * Needs GNU coreutils, gawk, sed, grep, diffutils, findutils, tar, gzip, util-linux and zip on the machine. Each command runs in a
 * fresh directory holding the corpus files. Output is stored as latin1 strings (one char per byte).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { buffers, cases } from './gnu-tools.corpus.mjs'

const root = mkdtempSync(join(tmpdir(), 'gnu-tools-'))
const golden = cases.map((cmd, index) => {
  const dir = join(root, `c${index}`)
  mkdirSync(join(dir, 'dir'), { recursive: true })
  for (const [name, data] of Object.entries(buffers)) writeFileSync(join(dir, name), data)
  const result = spawnSync('bash', ['-c', cmd], { cwd: dir, input: '', timeout: 20000, env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', TZ: 'UTC' } })
  return { cmd, out: result.stdout.toString('latin1'), code: result.status ?? -1, err: result.stderr.toString('latin1') }
})
rmSync(root, { recursive: true, force: true })

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gnu-tools.golden.json'), JSON.stringify(golden, null, 1))
console.log(`${golden.length} commands`)
