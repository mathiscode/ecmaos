import { describe, expect, it } from 'vitest'

import { Session } from './session.ts'
import { host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('connect, from one machine to another: refusals', () => {
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

  const Local = 'root:/tmp# '

  async function connectTo(session: Session, port: number, flags: string, answer = 'root') {
    const mark = session.output.length
    session.send(`connect ${flags} root@127.0.0.1:${port}\r`)
    await session.waitFor('unlocks your key', mark)
    session.send(`${answer}\r`)
    return mark
  }

  it('refuses a wrong password before anything is sent, and a wrong key', async () => {
    const { port, code, session: remote } = await host()
    const me = await client()
    let mark = await connectTo(me, port, `-y -p ${code}`, 'not-the-password')
    await me.waitFor('connect: Invalid password', mark)
    await me.waitFor(Local, mark)
    // nothing was enrolled
    expect(await remote.run('cat /root/.ssh/authorized_keys 2>&1')).not.toContain('ecdsa-p384')

    // a key that was never enrolled is refused with the generic message
    mark = await connectTo(me, port, '-y')
    await me.waitFor('connect: authentication failed', mark)
    await me.waitFor(Local, mark)
  })

  it('refuses a host whose key is not the pinned one, and a mismatched --fingerprint', async () => {
    const { port, code } = await host()
    const me = await client()
    const mark = me.output.length
    me.send(`connect -F SHA256:wrong root@127.0.0.1:${port}\r`)
    await me.waitFor('not SHA256:wrong', mark)
    await me.waitFor(Local, mark)

    // pin a different key for this address, then connect: the warning, and no password prompt
    await local(me, 'mkdir -p /root/.ssh')
    await local(me, `echo "127.0.0.1:${port} ecdsa-p384 ${btoa(JSON.stringify({ kty: 'EC', crv: 'P-384', x: 'A'.repeat(64), y: 'B'.repeat(64) }))}" > /root/.ssh/known_hosts`)
    const second = me.output.length
    me.send(`connect -p ${code} root@127.0.0.1:${port}\r`)
    await me.waitFor('HAS CHANGED', second)
    await me.waitFor(Local, second)
    expect(me.output.slice(second)).not.toContain('unlocks your key')
  })

  it('says plainly when nothing is listening', async () => {
    const me = await client()
    const mark = me.output.length
    me.send('connect -y root@127.0.0.1:1\r')
    await me.waitFor('connect: could not connect', mark)
    await me.waitFor(Local, mark)
  })
})
