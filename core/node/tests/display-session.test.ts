import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

import type { ToDisplay } from '@ecmaos/types'

import { Session } from './session.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24

/** Connects like the display page: token from the URL fragment, then collects the kernel's messages */
async function connect(url: string) {
  const parsed = new URL(url)
  const socket = new WebSocket(`ws://${parsed.host}/ws`, { headers: { Origin: parsed.origin } })
  const received: ToDisplay[] = []
  socket.on('message', data => received.push(JSON.parse(data.toString()) as ToDisplay))
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  socket.send(JSON.stringify({ t: 'hello', token: parsed.hash.slice(1) }))
  return { socket, received }
}

describe.skipIf(!supported)('windows on the bundled Node kernel', () => {
  let folder: string
  let record: string
  let session: Session

  /** The browser's stand-in: writes the address it was asked to open, then waits like a browser would */
  const launched = async () => {
    for (let i = 0; i < 200; i++) {
      try {
        const line = readFileSync(record, 'utf8').trim().split('\n').at(-1)
        if (line) return line.replace(/^--app=/, '')
      } catch { /* not yet */ }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('no host window was opened')
  }

  beforeAll(async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'ecmaos-display-'))
    record = path.join(folder, 'args')
    const browser = path.join(folder, 'browser.sh')
    writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${record}'\nexec sleep 30\n`)
    chmodSync(browser, 0o755)
    session = new Session(['--quiet', '--ephemeral'], { env: { ...process.env, DISPLAY: ':0', ECMAOS_BROWSER: browser } })
    await session.ready()
  })
  afterAll(async () => {
    await session.stop()
    rmSync(folder, { recursive: true, force: true })
  })

  it('shows a markdown file in a host window with `view`', async () => {
    await session.run('echo "# Hello window" > /root/a.md')
    expect(await session.run('view /root/a.md; echo status=$?')).toMatch(/status=0$/)
    const connection = await connect(await launched())
    for (let i = 0; i < 100 && connection.received.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(connection.received[1]).toMatchObject({ t: 'open', title: expect.stringContaining('a.md'), content: { html: expect.stringContaining('<h1>Hello window</h1>') } })
    connection.socket.close()
  })

  it('says a page-only command is unavailable instead of leaking a ReferenceError', async () => {
    const out = await session.run('echo hi | xclip -selection clipboard; echo status=$?')
    expect(out).not.toMatch(/ReferenceError|document is not defined/)
    expect(out).toMatch(/not available on this host/)
  })
})
