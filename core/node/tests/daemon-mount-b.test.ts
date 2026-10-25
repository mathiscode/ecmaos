import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Session } from './session.ts'
import { folders, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('mounting a directory of another machine, failing', () => {
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
    // the kernel logs to the terminal at any time; that is not what the command printed
    const lines = session.output.slice(mark).split('\n').filter(line => line.trim() !== command && !/^(root:\/tmp# )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ ecmaos:/.test(line))
    return lines.join('\n').replace(/root:\/tmp# $/, '').trim()
  }

  /** A shared folder on the host and a machine with it mounted at /mnt/share */
  async function mounted(options: { readOnly?: boolean, files?: Record<string, string | Buffer>, extra?: string } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ecmaosd-share-'))
    folders.push(dir)
    for (const [name, text] of Object.entries(options.files ?? { 'hello.txt': 'hello from the host\n' })) writeFileSync(path.join(dir, name), text)
    const { port, code } = await host(['--export', `share=${dir}${options.readOnly ? '' : ':rw'}`])
    const me = await client()
    const mark = me.output.length
    me.send(`mount -t ecmaos -o pair=${code},accept-new=yes${options.extra ?? ''} root@127.0.0.1:${port}/share /mnt/share\r`)
    await me.waitFor('unlocks your key', mark)
    const answered = me.output.length
    me.send('root\r')
    await me.waitFor(Local, answered)
    return { me, dir, port, mount: me.output.slice(mark) }
  }

  it('says plainly when the host is not known, the export does not exist, or the password is wrong', async () => {
    const { port, code } = await host(['--export', `share=${tmpdir()}`])
    const me = await client()
    const attempt = async (flags: string, name: string, password: string) => {
      const mark = me.output.length
      me.send(`mount -t ecmaos ${flags} root@127.0.0.1:${port}/${name} /mnt/x\r`)
      await me.waitFor('unlocks your key', mark)
      me.send(`${password}\r`)
      const started = Date.now()
      while (!/mount: [^\n]+\n(?:[^\n]*\n)*root:\/tmp# $/.test(me.output.slice(mark))) {
        if (Date.now() - started > 20_000) throw new Error(`no answer\n${me.output.slice(mark)}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return me.output.slice(mark).replace(/\n/g, ' ')
    }
    expect(await attempt(`-o pair=${code}`, 'share', 'root')).toContain('is not a known host')
    expect(await attempt(`-o pair=${code},accept-new=yes`, 'share', 'wrong-password')).toContain('Invalid password')
    expect(await attempt(`-o pair=${code},accept-new=yes`, 'nosuch', 'root')).toContain('no export named nosuch')
  })

  it('a host that goes away leaves the mount readable from its copy, fails changes loudly, and umount still works', async () => {
    const { me, dir } = await mounted()
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    const mark = me.output.length
    await sessions[0]!.stop() // the host, killed
    // reads are served from the copy made at mount time
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    // a change cannot reach the host: it never appears there, and the machine says so in its log
    await local(me, 'echo after > /mnt/share/late.txt')
    await me.waitFor('failed on the other machine: the connection to the other machine ended', mark)
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false)
    expect(await local(me, 'ls /mnt/share')).toContain('hello.txt')
    await local(me, 'umount /mnt/share')
    expect(await local(me, 'mount')).not.toContain('/mnt/share')
    expect(await local(me, 'echo still-working')).toBe('still-working')
  })

  it('umount ends the connection, and the machine goes on working when the host disappears', async () => {
    const { me, port } = await mounted()
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    await local(me, 'umount /mnt/share')
    expect(await local(me, 'mount')).not.toContain('/mnt/share')
    expect(await local(me, 'echo still-working')).toBe('still-working')
    expect(port).toBeGreaterThan(0)
  })
})
