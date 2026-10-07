import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { Session } from './session.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24

// The README says guest JavaScript is not contained. This pins that down: if programs are ever sandboxed, this test
// and the README's "Security" section change together.
describe.skipIf(!supported)('the trusted-code stance', () => {
  const host = mkdtempSync(path.join(tmpdir(), 'ecmaos-security-'))
  const marker = path.join(host, 'written-by-guest')

  it('lets a guest JavaScript program read the host environment and write host files', async () => {
    const program = `const { open, write, close, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls; ` +
      `const fs = process.getBuiltinModule('node:fs'); fs.writeFileSync('${marker}', 'secret=' + process.env.ECMAOS_TEST_SECRET); ` +
      `const fd = open('/done', O_WRONLY | O_CREAT | O_TRUNC, 0o644); write(fd, new TextEncoder().encode('ok')); close(fd)`
    const session = new Session(['--quiet', '--ephemeral'], { env: { ...process.env, ECMAOS_TEST_SECRET: 'hunter2' } })
    await session.ready()
    try {
      await session.run(`echo "${program}" > /root/escape.js && chmod +x /root/escape.js`)
      await session.run('/root/escape.js')
      for (let waited = 0; !existsSync(marker) && waited < 10_000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100))
      expect(readFileSync(marker, 'utf8')).toBe('secret=hunter2')
    } finally {
      await session.stop()
      rmSync(host, { recursive: true, force: true })
    }
  })
})
