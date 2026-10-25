import { describe, expect, it } from 'vitest'

import { Session } from './session.ts'
import { afterAsk, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('sharing a directory with another machine', () => {
  const Local = 'root:/tmp# '

  async function client() {
    const session = new Session(['--quiet'])
    sessions.push(session)
    await session.ready()
    session.send('cd /tmp\r')
    await session.waitFor(Local)
    return session
  }

  async function local(session: Session, command: string, timeout = 30_000) {
    const mark = session.output.length
    session.send(`${command}\r`)
    await session.waitFor(Local, mark + command.length, timeout)
    const lines = session.output.slice(mark).split('\n').filter(line => line.trim() !== command && !/^(root:\/tmp# )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ ecmaos:/.test(line))
    return lines.join('\n').replace(/root:\/tmp# $/, '').trim()
  }

  const eventually = async (check: () => Promise<boolean>, what: string) => {
    const started = Date.now()
    while (!(await check())) {
      if (Date.now() - started > 20_000) throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  async function shared(flags = '') {
    const { session: remote, port, code } = await host()
    const me = await client()
    await local(me, 'mkdir /tmp/data')
    await local(me, 'echo from the machine > /tmp/data/hello.txt')
    const mark = me.output.length
    me.send(`share -y -p ${code} ${flags} root@127.0.0.1:${port} /tmp/data demo\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('Sharing /tmp/data', mark)
    await me.waitFor(Local, afterAsk(me, mark))
    return { me, remote }
  }

  it('the host mounts it as /mnt/NAME, both sides see each other\'s changes, and stopping unmounts it', async () => {
    const { me, remote } = await shared()
    expect(await remote.run('cat /mnt/demo/hello.txt')).toContain('from the machine')
    await remote.run('echo from the host > /mnt/demo/h.txt')
    await eventually(async () => (await local(me, 'cat /tmp/data/h.txt')) === 'from the host', 'the machine to have the file the host wrote')
    expect(await local(me, 'share -l')).toContain('demo')

    await local(me, 'share -d demo')
    await eventually(async () => !(await remote.run('mount')).includes('/mnt/demo'), 'the host to drop the mount')
  })

  it('a read-only share cannot be changed from the host', async () => {
    const { me, remote } = await shared('-r')
    expect(await remote.run('cat /mnt/demo/hello.txt')).toContain('from the machine')
    await remote.run('echo changed > /mnt/demo/hello.txt')
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(await local(me, 'cat /tmp/data/hello.txt')).toBe('from the machine')
  })
})
