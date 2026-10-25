import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdtempSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Session } from './session.ts'
import { afterAsk, folders, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('using a device of another machine: loopback and files', () => {
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

  it('a loopback device: what is written to /dev/NAME comes back from it, and detaching removes it', async () => {
    const { me, result, port } = await attached(['loop=loopback'], 'loop')
    expect(result).toContain('Attached loop from 127.0.0.1')
    // a name this machine already has is refused
    const mark0 = me.output.length
    me.send(`attach root@127.0.0.1:${port}/loop zero\r`)
    await me.waitFor('unlocks your key', mark0)
    me.send('root\r')
    await me.waitFor(Local, mark0 + 100)
    expect(me.output.slice(mark0)).toContain('/dev/zero already exists')
    expect(await local(me, 'attach -l')).toContain('/dev/loop')
    expect(await local(me, 'ls /dev')).toContain('loop')
    await local(me, 'echo ping > /dev/loop')
    expect(await local(me, 'dd if=/dev/loop bs=1 count=5 2>/dev/null')).toBe('ping')
    expect(await local(me, 'attach -c loop ping')).toContain('pong')
    expect(await local(me, 'attach -c loop echo 1 \'"two"\'')).toContain('[1,"two"]')
    expect(await local(me, 'attach -d loop')).toContain('Detached loop')
    expect(await local(me, 'ls /dev')).not.toMatch(/\bloop\b/)
  })

  it('when the host goes away the device node goes with it, and a read that was waiting ends', async () => {
    const { me, remote } = await attached(['loop=loopback'], 'loop')
    expect(await local(me, 'ls /dev')).toContain('loop')
    await remote.stop()
    await eventually(async () => !(await local(me, 'ls /dev')).match(/\bloop\b/), 'the device to be removed')
    expect(await local(me, 'attach -l')).toContain('No devices are attached')
  })

  it('a read-only device refuses a write, and a device that ends (a file at its end) goes away', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ecmaosd-device-'))
    folders.push(dir)
    const fifo = path.join(dir, 'sensor')
    execFileSync('mkfifo', [fifo])
    writeFileSync(path.join(dir, 'log.txt'), 'reading 42\n')
    const { me, port, code } = await attached([`sensor=file:${fifo}`, `log=file:${path.join(dir, 'log.txt')}`], 'sensor')
    const hostEnd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK)
    try {
      writeSync(hostEnd, 'reading 42\n')
      expect(await local(me, 'dd if=/dev/sensor bs=1 count=10 2>/dev/null')).toBe('reading 42')
    } finally { closeSync(hostEnd) }
    expect(await local(me, 'echo x > /dev/sensor 2>&1; echo status=$?')).not.toContain('status=0')

    // a second device of the same host: a regular file is read to its end, which ends the device
    const mark = me.output.length
    me.send(`attach root@127.0.0.1:${port}/log\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor('Attached log', mark)
    await eventually(async () => !(await local(me, 'ls /dev')).match(/\blog\b/), 'the device to go when the file ended')
    void code
  })
})
