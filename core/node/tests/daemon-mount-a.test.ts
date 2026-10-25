import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { Session } from './session.ts'
import { folders, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('mounting a directory of another machine', () => {
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

  const until = async (check: () => boolean, what: string) => {
    const started = Date.now()
    while (!check()) {
      if (Date.now() - started > 15_000) throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  it('reads what is on the host, and a change made in the machine reaches the host', async () => {
    const { me, dir, mount } = await mounted()
    expect(mount).toContain('Mounted root@127.0.0.1')
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    expect(await local(me, 'ls /mnt/share')).toContain('hello.txt')

    await local(me, 'echo from the machine > /mnt/share/out.txt')
    await local(me, 'mkdir /mnt/share/made')
    await until(() => existsSync(path.join(dir, 'out.txt')) && existsSync(path.join(dir, 'made')), 'the host to see the new file and folder')
    await until(() => readFileSync(path.join(dir, 'out.txt'), 'utf8') === 'from the machine\n', 'the host file to hold the text')

    await local(me, 'rm /mnt/share/out.txt')
    await until(() => !existsSync(path.join(dir, 'out.txt')), 'the host to lose the file')
    expect(await local(me, 'mount')).toContain('/mnt/share')
  })

  it('moves an 8 MB file both ways, byte for byte', async () => {
    const data = Buffer.alloc(8 << 20)
    for (let index = 0; index < data.length; index++) data[index] = (index * 131 + (index >> 9)) % 256
    const hash = createHash('sha256').update(data).digest('hex')
    const { me, dir } = await mounted({ files: { 'big.bin': data } })
    // down: what the machine reads is what the host has
    expect(await local(me, 'sha256sum /mnt/share/big.bin')).toContain(hash)
    // up: a copy made inside the machine arrives whole
    await local(me, 'cp /mnt/share/big.bin /tmp/down.bin', 60_000)
    expect(await local(me, 'sha256sum /tmp/down.bin')).toContain(hash)
    await local(me, 'cp /tmp/down.bin /mnt/share/up.bin', 60_000)
    await until(() => existsSync(path.join(dir, 'up.bin')) && statSync(path.join(dir, 'up.bin')).size === data.length, 'the host to have all of the upload')
    expect(createHash('sha256').update(readFileSync(path.join(dir, 'up.bin'))).digest('hex')).toBe(hash)
  })

  it('refuses a tree over the limit, before copying any of it', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 30; index++) files[`f${index}.txt`] = 'x'
    const { me, mount } = await mounted({ files, extra: ',maxfiles=10' })
    expect(mount).toContain('larger than 10 files')
    expect(await local(me, 'ls /mnt/share 2>&1')).not.toContain('f1.txt')
  })

  it('writes to a read-only export are refused and the host file is untouched', async () => {
    const { me, dir } = await mounted({ readOnly: true })
    expect(await local(me, 'cat /mnt/share/hello.txt')).toBe('hello from the host')
    await local(me, 'echo changed > /mnt/share/hello.txt')
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('hello from the host\n')
  })
})
