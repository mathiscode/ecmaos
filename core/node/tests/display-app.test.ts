import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { findBrowser } from '../src/display/launch.ts'
import { Session } from './session.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24
// This runs a real Chromium without a screen, so it needs one installed; without it the sandbox is covered only by the protocol tests
const browser = findBrowser({ ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':0' })

describe.skipIf(!supported || 'unavailable' in browser)('an app in a host window sandbox', () => {
  let folder: string
  let session: Session

  beforeAll(async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'ecmaos-app-'))
    const wrapper = path.join(folder, 'headless.sh')
    writeFileSync(wrapper, `#!/bin/sh\nexec '${(browser as { path: string }).path}' --headless=new --disable-gpu --no-sandbox "$@"\n`)
    chmodSync(wrapper, 0o755)
    session = new Session(['--quiet', '--ephemeral'], { env: { ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':0', ECMAOS_BROWSER: wrapper } })
    await session.ready()
    // The app reads and writes files through the SDK, retitles its window and ends
    const source = [
      '#!ecmaos:bin:app:probe',
      'export const display = async sdk => {',
      "  const before = await sdk.fs.readFile('/root/in.txt', 'utf8')",
      "  await sdk.fs.writeFile('/root/out.txt', 'got ' + before.trim() + ' args ' + sdk.args.join(',') + ' uid ' + sdk.uid + ' cwd ' + sdk.cwd)",
      "  await sdk.fs.writeFile('/root/big.bin', new Uint8Array(100000).fill(7))",
      "  let unreadable = 'no'",
      "  try { await sdk.fs.readFile('/root/missing') } catch (error) { unreadable = 'yes' }",
      "  await sdk.fs.writeFile('/root/sandbox.txt', 'origin ' + location.origin + ' unreadable ' + unreadable + ' parentreach ' + (() => { try { return typeof parent.document } catch (error) { return 'blocked' } })())",
      '  await sdk.exit(0)',
      '}'
    ].join('\n')
    await session.run('echo "from the machine" > /root/in.txt')
    for (const line of source.split('\n')) await session.run(`echo ${JSON.stringify(line)} >> /root/probe.mjs`)
    await session.run('chmod +x /root/probe.mjs')
  })
  afterAll(async () => {
    await session.stop()
    rmSync(folder, { recursive: true, force: true })
  })

  it('runs in the sandbox, reaches files only through the SDK, and ends the process when it exits', async () => {
    expect(await session.run('cd /root && ./probe.mjs one two; echo status=$?', 60_000)).toMatch(/status=0$/)
    expect(await session.run('cat /root/out.txt')).toBe('got from the machine args one,two uid 0 cwd /root')
    expect(await session.run('wc -c < /root/big.bin')).toBe('100000')
    expect(await session.run('cat /root/sandbox.txt')).toBe('origin null unreadable yes parentreach blocked')
    expect(await session.run('wmctrl -l | wc -l')).toBe('0')
  })
})
