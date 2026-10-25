import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdtempSync, openSync, readSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Session } from './session.ts'
import { afterAsk, folders, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('using a device of another machine: FIFOs and offering', () => {
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

  const eventually = async (check: () => Promise<boolean> | boolean, what: string) => {
    const started = Date.now()
    while (!(await check())) {
      if (Date.now() - started > 20_000) throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  it('a FIFO read through the machine, and one the machine writes to', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ecmaosd-device-'))
    folders.push(dir)
    const input = path.join(dir, 'in')
    const output = path.join(dir, 'out')
    execFileSync('mkfifo', [input, output])
    // the host's own ends: a reader of the output first (a FIFO opened for writing needs one), a writer into the input
    const reader = openSync(output, constants.O_RDONLY | constants.O_NONBLOCK)
    const writer = openSync(input, constants.O_RDWR | constants.O_NONBLOCK)
    try {
      const { me, port } = await attached([`in=file:${input}`, `out=file:${output}:wo`], 'in')
      writeSync(writer, 'from the host\n')
      expect(await local(me, 'dd if=/dev/in bs=1 count=13 2>/dev/null')).toBe('from the host')

      const mark = me.output.length
      me.send(`attach root@127.0.0.1:${port}/out\r`)
      await me.waitFor('unlocks your key', mark)
      me.send('root\r')
      await me.waitFor('Attached out', mark)
      expect(await local(me, 'attach -l')).toMatch(/\/dev\/out\s+file\s+-w/)
      await local(me, 'echo from the machine > /dev/out')
      const got: string[] = []
      await eventually(() => {
        const buffer = Buffer.alloc(64)
        try { const count = readSync(reader, buffer, 0, 64, null); if (count > 0) got.push(buffer.subarray(0, count).toString()) } catch { /* nothing yet */ }
        return got.join('').includes('from the machine')
      }, 'the host to read what the machine wrote')
    } finally { closeSync(reader); closeSync(writer) }
  })

  it('offering a device of this machine: the host gets /dev/NAME, and stopping removes it', async () => {
    const { session: remote, port, code } = await host()
    const me = await client()
    const mark = me.output.length
    me.send(`attach -s -y -p ${code} root@127.0.0.1:${port} mydev loopback\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('Offering loopback', mark)
    await me.waitFor(Local, afterAsk(me, mark))
    expect(await local(me, 'attach -l')).toContain('offered to 127.0.0.1')

    await eventually(async () => (await remote.run('ls /dev')).includes('mydev'), 'the host to get the device node')
    await remote.run('echo hello > /dev/mydev')
    expect(await remote.run('dd if=/dev/mydev bs=1 count=6 2>/dev/null')).toContain('hello')

    // a name the host already has is refused with its reason
    const mark2 = me.output.length
    me.send(`attach -s root@127.0.0.1:${port} zero loopback\r`)
    await me.waitFor('unlocks your key', mark2)
    me.send('root\r')
    await me.waitFor(Local, mark2 + 100)
    expect(me.output.slice(mark2)).toContain('/dev/zero already exists')

    expect(await local(me, 'attach -d mydev')).toContain('Detached mydev')
    await eventually(async () => !(await remote.run('ls /dev')).includes('mydev'), 'the host to lose the device node')
  })
})
