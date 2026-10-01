/**
 * Regenerates `shell-parity.golden.json` from real bash:
 *
 *   node --experimental-strip-types core/kernel/tests/tree/fixtures/generate-shell-parity.mjs
 *
 * Only needed when the corpus changes. The goldens are committed so the tests need no bash.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FS_PREAMBLE, parseCorpus } from './shell-parity.ts'

const here = dirname(fileURLToPath(import.meta.url))
const cases = parseCorpus(readFileSync(join(here, 'shell-parity.corpus.txt'), 'utf8'))
const golden = {}

for (const { id, script, fs } of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'))
  const file = join(dir, 'script.sh')
  // The same preamble the shells get, so `/tmp/pc` is the working directory for both.
  writeFileSync(file, (fs ? FS_PREAMBLE : '') + script)
  const result = spawnSync('bash', ['--noprofile', '--norc', file], { encoding: 'utf8', cwd: '/', env: { PATH: process.env.PATH, HOME: '/root' }, timeout: 10000 })
  golden[id] = { stdout: result.stdout, status: result.status ?? -1 }
  rmSync(dir, { recursive: true, force: true })
}

writeFileSync(join(here, 'shell-parity.golden.json'), JSON.stringify(golden, null, 2) + '\n')
console.log(`${cases.length} cases`)
