import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Session } from './session.ts'
import { afterAsk, dataFolder, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('using a device of another machine: who may', () => {
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

  /** A host offering `devices` and a machine that has attached `wanted` from it as /dev/NAME */
  async function attached(devices: string[], wanted: string, as = wanted, data?: string) {
    const { session: remote, port, code } = await host(devices.flatMap(spec => ['--device', spec]), data)
    const me = await client()
    const mark = me.output.length
    me.send(`attach -y -p ${code} root@127.0.0.1:${port}/${wanted} ${as}\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor(Local, afterAsk(me, mark))
    return { me, remote, port, code, result: me.output.slice(mark) }
  }

  it('only the devices the host lists, and only to root; a device in use is refused', async () => {
    const { session: remote, port, code } = await host(['--device', 'loop=loopback'])
    void remote
    const me = await client()
    const mark = me.output.length
    me.send(`attach -y -p ${code} root@127.0.0.1:${port}/secret x\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor(Local, afterAsk(me, mark))
    expect(me.output.slice(mark)).toContain('no device named secret')
    expect(await local(me, 'attach -l')).toContain('No devices are attached')

    const none = await host([])
    const other = await client()
    const mark2 = other.output.length
    other.send(`attach -y -p ${none.code} root@127.0.0.1:${none.port}/loop\r`)
    await other.waitFor('unlocks your key', mark2)
    other.send('root\r')
    await other.waitFor(Local, mark2 + 100)
    expect(other.output.slice(mark2)).toContain('no device named loop')
  })

  it('devices can be listed in a file in the data folder, and a file device is held by one machine at a time', async () => {
    const data = dataFolder()
    mkdirSync(path.join(data, 'ecmaosd'))
    writeFileSync(path.join(data, 'ecmaosd', 'devices'), '# what this machine offers\nzero=file:/dev/zero\n')
    const { me, port, code } = await attached([], 'zero', 'rzero', data)
    expect(await local(me, 'dd if=/dev/rzero bs=1 count=4 2>/dev/null | od -An -tx1')).toContain('00 00 00 00')

    const mark = me.output.length
    me.send(`attach root@127.0.0.1:${port}/zero z2\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor(Local, afterAsk(me, mark))
    expect(me.output.slice(mark)).toContain('zero is in use')
    void code
  })
})
