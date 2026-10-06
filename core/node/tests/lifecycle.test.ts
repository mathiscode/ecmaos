import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { Session } from './session.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24
const Limit = 15_000
const clean: string[] = []
afterAll(() => { for (const dir of clean) rmSync(dir, { recursive: true, force: true }) })

/** Runs a session to its end, and returns how it ended and how long that took after the last input */
async function ends(session: Session) {
  const started = Date.now()
  await session.waitForExit(Limit)
  return { ...session.exit!, ms: Date.now() - started }
}

describe.skipIf(!supported)('the end of a session', () => {
  it('exits with 0 when its input ends, after the commands in it have run', async () => {
    const session = new Session(['--quiet', '--ephemeral'])
    await session.ready()
    session.end('echo done-before-eof')
    const result = await ends(session)
    expect(result).toMatchObject({ code: 0, signal: null })
    expect(session.output).toContain('done-before-eof')
  })

  it('exits with 0 on halt', async () => {
    const session = new Session(['--quiet', '--ephemeral'])
    await session.ready()
    session.send('halt\r')
    expect(await ends(session)).toMatchObject({ code: 0, signal: null })
  })

  it('exits with 0 on poweroff', async () => {
    const session = new Session(['--quiet', '--ephemeral'])
    await session.ready()
    session.send('poweroff\r')
    expect(await ends(session)).toMatchObject({ code: 0, signal: null })
  })

  it('stops on SIGTERM', async () => {
    const session = new Session(['--quiet', '--ephemeral'])
    await session.ready()
    session.signal('SIGTERM')
    expect(await ends(session)).toMatchObject({ code: 0, signal: null })
  })

  it('stops on SIGTERM while a command is running', async () => {
    const session = new Session(['--quiet', '--ephemeral'])
    await session.ready()
    session.send('sleep 60\r')
    await new Promise(resolve => setTimeout(resolve, 500))
    session.signal('SIGTERM')
    expect(await ends(session)).toMatchObject({ code: 0, signal: null })
  })

  it('reboots into a new process that finds what the old one kept', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'ecmaos-reboot-'))
    clean.push(data)
    const session = new Session(['--quiet'], { env: { ...process.env, ECMAOS_DATA: data } })
    await session.ready()
    session.send('echo kept > /root/rebooted\r')
    await session.waitFor('root:/root# ', session.output.length - 1)
    session.send('reboot\r')
    // A second boot prints a second first prompt
    await session.waitFor('root:/root# ', session.output.indexOf('reboot') + 6, 30_000)
    session.send('cat /root/rebooted\r')
    await session.waitFor('kept', session.output.lastIndexOf('cat /root/rebooted'), 30_000)
    session.end()
    expect(await ends(session)).toMatchObject({ code: 0, signal: null })
  }, 90_000)
})
