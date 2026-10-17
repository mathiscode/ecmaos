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

  it('checks every file call against the user who started the app', async () => {
    await session.run('useradd -m -p secret alice')
    await session.run('mkdir /pub; echo top-secret > /pub/secret.txt; echo shared > /pub/shared.txt; chmod 600 /pub/secret.txt; chmod 644 /pub/shared.txt; chmod 755 /pub')
    const attempt = (name: string, body: string) => [
      `  try { ${body}; results.push('${name}=allowed') } catch (error) { results.push('${name}=' + (error && error.message ? error.message.split(':')[0] : 'denied')) }`
    ]
    const source = [
      '#!ecmaos:bin:app:perm',
      'export const display = async sdk => {',
      '  const results = []',
      ...attempt('read-secret', "await sdk.fs.readFile('/pub/secret.txt', 'utf8')"),
      ...attempt('read-shared', "await sdk.fs.readFile('/pub/shared.txt', 'utf8')"),
      ...attempt('write-pub', "await sdk.fs.writeFile('/pub/new.txt', 'x')"),
      ...attempt('append-shared', "await sdk.fs.appendFile('/pub/shared.txt', 'x')"),
      ...attempt('unlink-shared', "await sdk.fs.unlink('/pub/shared.txt')"),
      ...attempt('mkdir-pub', "await sdk.fs.mkdir('/pub/dir')"),
      ...attempt('read-root-home', "await sdk.fs.readdir('/root')"),
      ...attempt('write-home', "await sdk.fs.writeFile('/home/alice/mine.txt', 'mine')"),
      "  await sdk.fs.writeFile('/home/alice/result.txt', 'uid ' + sdk.uid + ' ' + results.join(' '))",
      '  await sdk.exit(0)',
      '}'
    ].join('\n')
    for (const line of source.split('\n')) await session.run(`echo ${JSON.stringify(line)} >> /pub/perm.mjs`)
    await session.run('chmod 755 /pub/perm.mjs')

    expect(await session.run('su alice -c /pub/perm.mjs; echo status=$?', 60_000)).toMatch(/status=0$/)
    const result = await session.run('cat /home/alice/result.txt')
    expect(result).toContain('uid 1000')
    expect(result).toMatch(/read-secret=EACCES/)
    expect(result).toContain('read-shared=allowed')
    expect(result).toMatch(/write-pub=EACCES/)
    expect(result).toMatch(/append-shared=EACCES/)
    expect(result).toMatch(/unlink-shared=EACCES/)
    expect(result).toMatch(/mkdir-pub=EACCES/)
    expect(result).toMatch(/read-root-home=EACCES/)
    expect(result).toContain('write-home=allowed')
    // what it wrote belongs to the user, and nothing it was refused exists
    expect(await session.run('ls -l /home/alice/mine.txt')).toMatch(/alice alice/)
    expect(await session.run('ls -1 /pub')).toBe('perm.mjs\nsecret.txt\nshared.txt')
    expect(await session.run('cat /pub/shared.txt')).toBe('shared')
  })
})
