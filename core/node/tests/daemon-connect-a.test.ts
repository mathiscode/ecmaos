import { describe, expect, it } from 'vitest'

import { Session } from './session.ts'
import { host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('connect, from one machine to another: pairing and keys', () => {
  /** A second machine whose shell is at /tmp, so its prompt differs from the host's, which is at /root */
  async function client() {
    const session = new Session(['--quiet'])
    sessions.push(session)
    await session.ready()
    session.send('cd /tmp\r')
    await session.waitFor('root:/tmp# ')
    return session
  }

  /** Runs a command on the second machine (whose prompt is not the one `Session.run` looks for) and returns what it printed */
  async function local(session: Session, command: string) {
    const mark = session.output.length
    session.send(`${command}\r`)
    await session.waitFor('root:/tmp# ', mark + command.length)
    return session.output.slice(mark).split('\n').slice(1).join('\n').replace(/root:\/tmp# $/, '').trim()
  }

  const Remote = 'root:/root# '
  const Local = 'root:/tmp# '

  async function connectTo(session: Session, port: number, flags: string, answer = 'root') {
    const mark = session.output.length
    session.send(`connect ${flags} root@127.0.0.1:${port}\r`)
    await session.waitFor('unlocks your key', mark)
    session.send(`${answer}\r`)
    return mark
  }

  it('pairs a key, opens a shell on the other machine, and returns to its own on exit', async () => {
    const { port, code, fingerprint } = await host()
    const me = await client()

    const mark = await connectTo(me, port, `-y -p ${code}`)
    await me.waitFor(Remote, mark)
    expect(me.output.slice(mark)).toContain(`Added 127.0.0.1:${port} (${fingerprint})`)
    me.send('echo remote-$USER-$HOME\r')
    await me.waitFor('remote-root-/root', mark)
    me.send('exit\r')
    await me.waitFor('Connection closed.', mark)
    await me.waitFor(Local, mark)

    expect(await local(me, 'cat /root/.ssh/known_hosts')).toMatch(new RegExp(`^127\\.0\\.0\\.1:${port} ecdsa-p384 `))
    expect(await local(me, 'ls -l /root/.ssh/id_ecdsa')).toMatch(/^-rw-------/)
  })

  it('logs in with the enrolled key alone the second time, and keeps the terminal usable afterwards', async () => {
    const { port, code } = await host()
    const me = await client()
    let mark = await connectTo(me, port, `-y -p ${code}`)
    await me.waitFor(Remote, mark)
    me.send('exit\r')
    await me.waitFor(Local, mark)

    mark = await connectTo(me, port, '')
    await me.waitFor(Remote, mark)
    me.send('exit\r')
    await me.waitFor('Connection closed.', mark)
    await me.waitFor(Local, mark)
    // echo and line editing are back on the local terminal
    expect(await local(me, 'echo local-again')).toBe('local-again')
  })
})
