import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `chattr +i` and `+a`, which the filesystem keeps for everyone, root included, and `lsattr`, which shows them */
describe('immutable and append-only files', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  // a command that redirects its own output keeps it: only its errors are collected
  const run = async (command: string) => {
    const code = await kernel.shell.execute(command.includes('>') ? `${command} 2> /tmp/err` : `${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }
  const asUser = async (command: string) => {
    const code = await kernel.runDetached({ username: 'alice', command: '/bin/ecmash', args: ['-c', `'${command} > /tmp/user.out 2>&1'`] })
    return { code, out: await read('/tmp/user.out') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    await kernel.users.add({ username: 'alice', password: 'wonderland', home: '/home/alice' })
  }, 60_000)

  it('an immutable file is not written, truncated, removed, renamed, linked or changed, even by root', async () => {
    await fs().mkdir('/srv/i', { recursive: true })
    await fs().writeFile('/srv/i/locked', 'original\n')
    expect((await run('chattr +i /srv/i/locked')).code).toBe(0)
    expect((await run('lsattr /srv/i/locked')).out).toBe('----i----------------- /srv/i/locked\n')
    expect((await run('lsattr -l /srv/i/locked')).out).toBe(`${'/srv/i/locked'.padEnd(28)} Immutable\n`)

    for (const command of ['echo more >> /srv/i/locked', 'echo new > /srv/i/locked', 'truncate -s 0 /srv/i/locked', 'rm -f /srv/i/locked', 'mv /srv/i/locked /srv/i/moved', 'ln /srv/i/locked /srv/i/hard', 'chmod 600 /srv/i/locked', 'chown alice /srv/i/locked', 'touch /srv/i/locked']) {
      const result = await run(command)
      expect(result.code, command).not.toBe(0)
      // the shell says why a redirection failed on the terminal, not on the command's own stderr
      if (!command.includes('>')) expect(result.err, command).toMatch(/Operation not permitted|EPERM/i)
    }
    expect(await read('/srv/i/locked')).toBe('original\n')
    expect(await fs().exists('/srv/i/moved')).toBe(false)
    // the kernel's own writes are refused too
    await expect(fs().writeFile('/srv/i/locked', 'x')).rejects.toThrow()
    await expect(fs().unlink('/srv/i/locked')).rejects.toThrow()
    // reading it is as before
    expect((await run('cat /srv/i/locked')).out).toBe('original\n')

    expect((await run('chattr -i /srv/i/locked')).code).toBe(0)
    expect((await run('lsattr /srv/i/locked')).out).toBe('---------------------- /srv/i/locked\n')
    expect((await run('rm /srv/i/locked')).code).toBe(0)
  }, 60_000)

  it('an append-only file is only appended to, and stays', async () => {
    await fs().writeFile('/srv/log', 'one\n')
    expect((await run('chattr +a /srv/log')).code).toBe(0)
    expect((await run('echo two >> /srv/log')).code).toBe(0)
    expect(await read('/srv/log')).toBe('one\ntwo\n')
    for (const command of ['echo over > /srv/log', 'truncate -s 0 /srv/log', 'rm -f /srv/log', 'mv /srv/log /srv/log.1', 'chmod 600 /srv/log']) {
      const result = await run(command)
      expect(result.code, command).not.toBe(0)
    }
    expect(await read('/srv/log')).toBe('one\ntwo\n')
    expect((await run('chattr -a /srv/log')).code).toBe(0)
  }, 60_000)

  it('an immutable directory gains and loses nothing; an append-only one only gains', async () => {
    await fs().mkdir('/srv/frozen/sub', { recursive: true })
    await fs().writeFile('/srv/frozen/kept', 'k')
    await run('chattr +i /srv/frozen')
    expect((await run('touch /srv/frozen/new')).code).not.toBe(0)
    expect((await run('rm /srv/frozen/kept')).code).not.toBe(0)
    expect((await run('mkdir /srv/frozen/other')).code).not.toBe(0)
    // what is inside is not itself immutable
    expect((await run('echo changed > /srv/frozen/kept')).code).toBe(0)
    await run('chattr -i /srv/frozen')

    await fs().mkdir('/srv/drop', { recursive: true })
    await run('chattr +a /srv/drop')
    expect((await run('echo a > /srv/drop/one')).code).toBe(0)
    expect((await run('rm /srv/drop/one')).code).not.toBe(0)
    expect((await run('mv /srv/drop/one /srv/drop/two')).code).not.toBe(0)
    expect((await run('lsattr -d /srv/drop')).out).toBe('-----a---------------- /srv/drop\n')
    await run('chattr -a /srv/drop')
    expect((await run('rm -r /srv/drop')).code).toBe(0)
  }, 60_000)

  it('only root sets i and a; the owner sets the others, which lsattr shows', async () => {
    expect((await asUser('touch /home/alice/mine')).code).toBe(0)
    const user = await asUser('chattr +i /home/alice/mine')
    expect(user.code).not.toBe(0)
    expect(user.out).toMatch(/Operation not permitted while setting flags on \/home\/alice\/mine/)
    expect((await asUser('chattr +d /home/alice/mine')).code).toBe(0)
    expect((await run('lsattr /home/alice/mine')).out).toBe('------d--------------- /home/alice/mine\n')
    expect((await run('chattr =iA /home/alice/mine')).code).toBe(0)
    expect((await run('lsattr /home/alice/mine')).out).toBe('----i--A-------------- /home/alice/mine\n')
    expect((await asUser('chattr -i /home/alice/mine')).code).not.toBe(0)
    expect((await run('chattr -V -i /home/alice/mine')).out).toBe('Flags of /home/alice/mine set as -------A--------------\n')
  }, 60_000)

  it('chattr -R walks a tree, and lsattr -R lists one', async () => {
    await fs().mkdir('/srv/tree/a', { recursive: true })
    await fs().writeFile('/srv/tree/a/f', 'f')
    await fs().writeFile('/srv/tree/g', 'g')
    expect((await run('chattr -R +d /srv/tree')).code).toBe(0)
    expect((await run('lsattr -R /srv/tree')).out).toBe('------d--------------- /srv/tree/a\n------d--------------- /srv/tree/g\n\n/srv/tree/a:\n------d--------------- /srv/tree/a/f\n')
    expect((await run('chattr +q /srv/tree')).err).toMatch(/invalid mode/)
  }, 60_000)
})
