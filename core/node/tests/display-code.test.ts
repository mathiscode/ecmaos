import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FsShareChannel, MessageStream, serveFs } from '@ecmaos/peer'
import type { Connection } from '@ecmaos/peer'

import { openExport, parseExport } from '../src/exports.ts'
import { findBrowser } from '../src/display/launch.ts'
import { Session } from './session.ts'
import { dial, generateKeyPair, login, openShell } from './peer-client.ts'
import type { Shell } from './peer-client.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24
const browser = findBrowser({ ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':0' })
// The editor is a built artifact (`pnpm build` in apps/code: about 13 MB, with Monaco and its workers inlined), and this runs a real Chromium without a screen
const code = path.resolve(import.meta.dirname, '../../../apps/code/dist/code.js')

describe.skipIf(!supported || 'unavailable' in browser || !existsSync(code))('the code editor in a host window sandbox', () => {
  let folder: string
  let session: Session
  let connection: Connection
  let shell: Shell

  beforeAll(async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'ecmaos-code-'))
    const wrapper = path.join(folder, 'headless.sh')
    writeFileSync(wrapper, `#!/bin/sh\nexec '${(browser as { path: string }).path}' --headless=new --disable-gpu --no-sandbox "$@"\n`)
    chmodSync(wrapper, 0o755)
    session = new Session(['--quiet', '--ephemeral', '--listen=0'], { env: { ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':0', ECMAOS_BROWSER: wrapper } })
    await session.ready()
    await session.waitFor('pairing code for')
    connection = await dial(Number(/listening on 127\.0\.0\.1:(\d+)/.exec(session.output)![1]))
    await login(connection, 'root', await generateKeyPair(), { code: /pairing code for (\w+): (\d{3}-\d{3})/.exec(session.output)![2]! })
    shell = await openShell(connection)
    await shell.waitFor('root:/root# ')

    // the editor reaches the machine as a directory shared over the peer link, which is quicker than typing 13 MB into a terminal
    const shared = path.join(folder, 'apps')
    mkdirSync(shared)
    copyFileSync(code, path.join(shared, 'code.js'))
    const channel = await connection.open(FsShareChannel, { params: { name: 'apps', readOnly: true }, timeout: 30_000 })
    serveFs(new MessageStream(channel), await openExport(parseExport(`apps=${shared}`)), { readOnly: true })
  }, 120_000)
  afterAll(async () => {
    connection?.close()
    await session.stop()
    rmSync(folder, { recursive: true, force: true })
  })

  it('loads Monaco and its workers, and opens the file through the SDK', async () => {
    // the machine copies the shared directory before it mounts it
    for (let i = 0; i < 120 && !(await shell.run('ls /mnt/apps')).includes('code.js'); i++) await new Promise(resolve => setTimeout(resolve, 500))
    await shell.run('cp /mnt/apps/code.js /root/code.mjs && chmod +x /root/code.mjs && echo hello > /root/note.txt && cd /root')
    await shell.send('./code.mjs note.txt &\r')
    // the title is set once the editor exists, with the file's name
    let listing = ''
    for (let i = 0; i < 120 && !listing.includes('Code Editor - /root/note.txt'); i++) { await new Promise(resolve => setTimeout(resolve, 500)); listing = await shell.run('wmctrl -l') }
    expect(listing).toContain('Code Editor - /root/note.txt')
    expect(await shell.run('cat /root/note.txt')).toBe('hello')
  }, 180_000)
})
