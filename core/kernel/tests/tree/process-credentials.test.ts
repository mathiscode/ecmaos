import { beforeAll, describe, expect, it } from 'vitest'
import { bindContext } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { canRunProgramsAsUser, setIds } from '#lib/process-credentials.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('programs run as the user who started them', () => {
  let kernel: Kernel
  let alice: { uid: number, gid: number }
  let bob: { uid: number, gid: number }
  let gateOpen = false
  const internals = () => kernel as unknown as { _programsRunAsUser: boolean }

  const asUser = async (user: { uid: number, gid: number }, home: string, run: () => Promise<void>) => {
    const root = { ...kernel.shell.credentials }
    const rootContext = kernel.shell.context
    const cred = { uid: user.uid, gid: user.gid, suid: user.uid, sgid: user.gid, euid: user.uid, egid: user.gid, groups: [user.gid] }
    kernel.shell.credentials = cred
    kernel.shell.context = bindContext({ root: '/', pwd: '/', credentials: cred })
    kernel.shell.cwd = home
    try { await run() } finally {
      kernel.shell.credentials = root
      kernel.shell.context = rootContext
      kernel.shell.cwd = '/'
    }
  }
  const asAlice = (run: () => Promise<void>) => asUser(alice, '/home/alice', run)
  // each user writes their own output files: a shared one would belong to whoever ran first
  const status = async (command: string) => {
    const mine = `/tmp/pc-${kernel.shell.credentials.uid}`
    await kernel.filesystem.fs.unlink(`${mine}-out`).catch(() => {})
    await kernel.filesystem.fs.unlink(`${mine}-err`).catch(() => {})
    const code = await kernel.shell.execute(`${command} > ${mine}-out 2> ${mine}-err`)
    const read = (name: string) => kernel.filesystem.fs.readFile(`${mine}-${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    await kernel.users.add({ username: 'alice', password: 'wonder', home: '/home/alice', shell: '/bin/ecmash' })
    await kernel.users.add({ username: 'bob', password: 'builder', home: '/home/bob', shell: '/bin/ecmash' })
    const named = (name: string) => [...(kernel.users.all as Map<number, { uid: number, gid: number, username: string }>).values()].find(u => u.username === name)!
    alice = named('alice')
    bob = named('bob')
    gateOpen = await canRunProgramsAsUser(kernel.filesystem.fs)
  }, 60000)

  it('the boot probe agrees with a direct check and leaves nothing behind', async () => {
    expect(internals()._programsRunAsUser).toBe(gateOpen)
    expect(await kernel.filesystem.fs.exists('/run/.credentials-probe')).toBe(false)
    // and its context is not left behind for `ps` to list as a kernel row owned by an id nobody has
    expect((await status('ps')).out).not.toContain('64000')
  })

  it('a root shell still starts root programs', async () => {
    await kernel.shell.execute('cat /proc/self/status > /tmp/root-status')
    expect(await kernel.filesystem.fs.readFile('/tmp/root-status', 'utf-8')).toMatch(/Uid:\t0\t0\t0\t0/)
  })

  it('the published @zenfs/core is enough to run programs as the user', () => {
    expect(gateOpen).toBe(true)
  })

  it('a user shell starts programs as that user when the installed zenfs allows it', async () => {
    await asAlice(async () => {
      const result = await status('cat /proc/self/status')
      expect(result.code).toBe(0)
      const want = gateOpen ? alice.uid : 0
      expect(result.out).toMatch(new RegExp(`Uid:\\t${want}\\t${want}\\t${want}\\t${want}`))
    })
  }, 30000)

  it('file permissions apply to that user', async () => {
    if (!gateOpen) return
    await asAlice(async () => {
      expect((await status('cat /etc/shadow')).code).not.toBe(0)
      expect((await status('cat /etc/passwd')).code).toBe(0)
      expect((await status('touch /home/alice/mine')).code).toBe(0)
      expect((await kernel.filesystem.fs.stat('/home/alice/mine')).uid).toBe(alice.uid)
    })
  }, 30000)

  it('a user cannot change system directories but can use /tmp', async () => {
    if (!gateOpen) return
    await asAlice(async () => {
      expect((await status('touch /etc/nope')).code).not.toBe(0)
      expect((await status('touch /bin/nope')).code).not.toBe(0)
      expect((await status('mkdir /newdir')).code).not.toBe(0)
      expect((await status('touch /tmp/alice-file')).code).toBe(0)
    })
    expect(await kernel.filesystem.fs.exists('/etc/nope')).toBe(false)
    expect(await kernel.filesystem.fs.exists('/newdir')).toBe(false)
  }, 30000)

  it('a user cannot remove or replace a file another user left in /tmp', async () => {
    if (!gateOpen) return
    await kernel.filesystem.fs.writeFile('/tmp/roots-file', 'mine', { mode: 0o666 })
    await asAlice(async () => {
      expect((await status('rm /tmp/roots-file')).code).not.toBe(0)
    })
    expect(await kernel.filesystem.fs.exists('/tmp/roots-file')).toBe(true)
  }, 30000)

  it('programs that need the kernel work for a user, and clean up after themselves', async () => {
    if (!gateOpen) return
    const before = (await kernel.filesystem.fs.readdir('/tmp')).filter(name => name.startsWith('.')).sort()
    await asAlice(async () => {
      const works = [
        'df', 'ps', 'ps -e', 'who', 'last', 'uptime', 'free', 'id', 'id alice', 'groups', 'groups alice', 'whoami', 'hostname',
        'uname -a', 'tty', 'date', 'nproc', 'stat /home/alice', 'mktemp', 'mount', 'cp /etc/passwd /tmp/alice-copy',
        'chsh -s /bin/ecmash', 'echo a | sort | uniq', 'ecmash -c "id; ps | head -2"'
      ]
      for (const command of works) expect((await status(command)).code, command).toBe(0)

      // `id` reports the user, not root
      expect((await status('id')).out).toContain(`uid=${alice.uid}`)
    })
    const after = (await kernel.filesystem.fs.readdir('/tmp')).filter(name => name.startsWith('.')).sort()
    expect(after).toEqual(before)
  }, 120000)

  it('what a user may not do is refused with a permission error, not a crash', async () => {
    if (!gateOpen) return
    await asAlice(async () => {
      const refused = [
        'touch /etc/shadow', 'rm /etc/passwd', 'chmod 777 /etc/passwd', 'chown alice /etc/passwd', 'kill 1', 'kill -TERM 1',
        'reboot', 'halt', 'poweroff', 'user add bob', 'user list'
      ]
      for (const command of refused) {
        const result = await status(command)
        expect(result.code, command).not.toBe(0)
        expect(result.err, command).toMatch(/denied|not permitted|EACCES|EPERM/i)
      }
    })
    expect(await kernel.filesystem.fs.readFile('/etc/passwd', 'utf-8')).toContain('root')
  }, 120000)

  it('chmod and chown depend on owning the file: directories work, a read-only file of her own can change, someone else\'s cannot', async () => {
    if (!gateOpen) return
    await kernel.filesystem.fs.mkdir('/home/alice/dir')
    await kernel.filesystem.fs.chown('/home/alice/dir', alice.uid, alice.gid)
    await kernel.filesystem.fs.writeFile('/home/alice/ro', 'x', { mode: 0o444 })
    await kernel.filesystem.fs.chown('/home/alice/ro', alice.uid, alice.gid)
    await kernel.filesystem.fs.writeFile('/tmp/not-alices', 'x', { mode: 0o666 })

    await asAlice(async () => {
      expect((await status('chmod 700 /home/alice/dir')).code).toBe(0)
      expect((await status('chmod 640 /home/alice/ro')).code).toBe(0)
      const foreign = await status('chmod 600 /tmp/not-alices')
      expect(foreign.code).not.toBe(0)
      expect(foreign.err).toMatch(/EPERM|not permitted/i)
      expect((await status('chown root /home/alice/ro')).code).not.toBe(0)
    })
    expect((await kernel.filesystem.fs.stat('/home/alice/dir')).mode & 0o777).toBe(0o700)
    expect((await kernel.filesystem.fs.stat('/home/alice/ro')).mode & 0o777).toBe(0o640)
    expect((await kernel.filesystem.fs.stat('/tmp/not-alices')).mode & 0o777).toBe(0o666)
  }, 60000)

  it('chgrp and chown ask the kernel for what an owner may do, and refuse what only root may', async () => {
    if (!gateOpen) return
    await kernel.filesystem.fs.mkdir('/home/alice/shared')
    await kernel.filesystem.fs.chown('/home/alice/shared', alice.uid, alice.gid)
    await kernel.filesystem.fs.writeFile('/home/alice/keep', 'x', { mode: 0o444 })
    await kernel.filesystem.fs.chown('/home/alice/keep', alice.uid, alice.gid)

    await asAlice(async () => {
      // her own directory and read-only file, to the group she is in, are hers to change
      expect((await status(`chgrp ${alice.gid} /home/alice/shared`)).code).toBe(0)
      expect((await status(`chown ${alice.uid}:${alice.gid} /home/alice/keep`)).code).toBe(0)
      expect((await status('chmod u+w /home/alice/keep')).code).toBe(0)
      // a group she is not in, and giving a file away, are root's
      const group = await status('chgrp 0 /home/alice/shared')
      expect(group.code).not.toBe(0)
      expect(group.err).toMatch(/EPERM|not permitted/i)
      expect((await status(`chown ${bob.uid} /home/alice/keep`)).code).not.toBe(0)
      // and nobody else's file is theirs to change
      expect((await status('chmod 777 /etc/passwd')).code).not.toBe(0)
      expect((await status(`chgrp ${alice.gid} /etc`)).code).not.toBe(0)
    })
    expect((await kernel.filesystem.fs.stat('/home/alice/shared')).gid).toBe(alice.gid)
    expect((await kernel.filesystem.fs.stat('/home/alice/keep')).uid).toBe(alice.uid)
    expect((await kernel.filesystem.fs.stat('/etc/passwd')).mode & 0o777).not.toBe(0o777)
  }, 60000)

  it('one user cannot reach into another user\'s home directory', async () => {
    if (!gateOpen) return
    await kernel.filesystem.fs.writeFile('/home/alice/diary.txt', 'private', { mode: 0o644 })
    await kernel.filesystem.fs.chown('/home/alice/diary.txt', alice.uid, alice.gid)

    await asAlice(async () => {
      expect((await status('cat /home/alice/diary.txt')).out).toBe('private')
    })
    await asUser(bob, '/home/bob', async () => {
      for (const command of ['cat /home/alice/diary.txt', 'ls /home/alice', 'stat /home/alice/diary.txt', 'cp /home/alice/diary.txt /tmp/stolen', 'touch /home/alice/planted']) {
        const result = await status(command)
        expect(result.code, command).not.toBe(0)
        expect(result.err, command).toMatch(/denied|EACCES/i)
      }
      // his own home is his, and /home itself can be listed
      expect((await status('touch /home/bob/mine')).code).toBe(0)
      expect((await status('ls /home')).out).toContain('alice')
    })
    expect(await kernel.filesystem.fs.exists('/tmp/stolen')).toBe(false)
    expect(await kernel.filesystem.fs.exists('/home/alice/planted')).toBe(false)
  }, 60000)

  describe('privileged operations belong to root processes', () => {
    /** Runs a small program as the current shell user and returns what it wrote, or what it was refused with. */
    const program = async (name: string, body: string) => {
      const file = `/tmp/${name}-${kernel.shell.credentials.uid}.js`
      await kernel.filesystem.fs.writeFile(file, `
        const s = globalThis.ecmaosSyscalls
        let result
        try { result = { value: await (async () => { ${body} })() } } catch (error) { result = { error: String(error?.message ?? error), errno: error?.errno } }
        const fd = s.open('${file}.json', s.O_WRONLY | s.O_CREAT | s.O_TRUNC, 0o644)
        s.write(fd, new TextEncoder().encode(JSON.stringify(result ?? null)))
        s.close(fd)
      `, { mode: 0o755 })
      await kernel.filesystem.fs.chmod(file, 0o755)
      expect(await kernel.shell.execute(file)).toBe(0)
      return JSON.parse(await kernel.filesystem.fs.readFile(`${file}.json`, 'utf-8')) as { value?: unknown, error?: string, errno?: number }
    }

    it('mount, umount and the kernel shell are refused to a user', async () => {
      if (!gateOpen) return
      await asAlice(async () => {
        const mount = await status('mount -t memory /mnt/user-mount')
        expect(mount.code).not.toBe(0)
        expect(mount.err + mount.out).toMatch(/only root|denied|not permitted/i)
        expect((await status('umount /tmp')).code).not.toBe(0)
        expect((await status('reboot -f')).code).not.toBe(0)

        const exec = await program('shell-exec', "return await s.custom('shell_exec', 'touch /tmp/shell-exec-ran')")
        expect(exec.error).toMatch(/not permitted/i)
      })
      expect(await kernel.filesystem.fs.exists('/tmp/shell-exec-ran')).toBe(false)
      expect(kernel.filesystem.mounts.has('/mnt/user-mount')).toBe(false)
    }, 60000)

    it('a root process can start a program as another user; a user cannot', async () => {
      if (!gateOpen) return
      const spawnAs = (out: string) => `
        const pid = await s.spawn('/bin/cp', ['cp', '/proc/self/status', '${out}'], { cwd: '/', credentials: { uid: ${bob.uid}, gid: ${bob.gid}, groups: [${bob.gid}] } })
        await s.waitpid(pid, false)
        return 'spawned'`

      const rootRun = await program('spawn-as', spawnAs('/tmp/spawned-by-root'))
      expect(rootRun.value).toBe('spawned')
      expect(await kernel.filesystem.fs.readFile('/tmp/spawned-by-root', 'utf-8')).toMatch(new RegExp(`Uid:\\t${bob.uid}\\t${bob.uid}\\t${bob.uid}\\t${bob.uid}`))
      expect((await kernel.filesystem.fs.stat('/tmp/spawned-by-root')).uid).toBe(bob.uid)

      await asAlice(async () => {
        const refused = await program('spawn-as', spawnAs('/tmp/spawned-by-alice'))
        expect(refused.error).toMatch(/not permitted/i)
      })
      expect(await kernel.filesystem.fs.exists('/tmp/spawned-by-alice')).toBe(false)
    }, 60000)

    it('passwd changes the password of the user who runs it, not the first terminal\'s user', async () => {
      if (!gateOpen) return
      await asUser(bob, '/home/bob', async () => {
        expect((await status('passwd builder newsecret1')).code).toBe(0)
      })
      await expect(kernel.users.login('bob', 'newsecret1')).resolves.toBeDefined()
      await expect(kernel.users.login('root', 'root')).resolves.toBeDefined()
      await kernel.users.login('bob', 'builder').then(() => { throw new Error('old password still works') }, () => {})
    }, 60000)

    it('the login family is refused to a user', async () => {
      if (!gateOpen) return
      await asAlice(async () => {
        for (const call of ["s.custom('login_begin', 0, 'root')", "s.custom('login_end', 0)"]) {
          const result = await program('login-call', `return await ${call}`)
          expect(result.error, call).toMatch(/not permitted/i)
        }
      })
    }, 60000)

    it('a user cannot signal another user\'s processes or process groups, and can signal their own', async () => {
      if (!gateOpen) return
      let alicePid = 0
      await asAlice(async () => {
        await kernel.shell.execute('sleep 60 &')
        alicePid = Number((await status('ps')).out.split('\n').find(line => line.includes('sleep'))?.trim().split(/\s+/)[0])
        expect(alicePid).toBeGreaterThan(1)
        expect((await status(`kill -0 ${alicePid}`)).code).toBe(0)
      })

      await asUser(bob, '/home/bob', async () => {
        const refused = await status(`kill -9 ${alicePid}`)
        expect(refused.code).not.toBe(0)
        expect(refused.err).toMatch(/not permitted|EPERM/i)
        const group = await program('killpg', `return await s.custom('proc_killpg', ${alicePid}, 9)`)
        expect(group.error).toMatch(/not permitted/i)
        // init is not a user's to signal either
        expect((await status('kill -9 1')).code).not.toBe(0)
      })

      await asAlice(async () => {
        expect((await status(`kill -0 ${alicePid}`)).code).toBe(0)
        expect((await status(`kill -9 ${alicePid}`)).code).toBe(0)
      })
    }, 90000)

    it('id and users_lookup report the user the program runs as', async () => {
      if (!gateOpen) return
      await asUser(bob, '/home/bob', async () => {
        const who = await status('id')
        expect(who.out).toContain(`uid=${bob.uid}`)
      })
    }, 30000)
  })

  it('with the gate closed every program still runs, as root', async () => {
    internals()._programsRunAsUser = false
    try {
      await asAlice(async () => {
        const result = await status('cat /proc/self/status')
        expect(result.code).toBe(0)
        expect(result.out).toMatch(/Uid:\t0\t0\t0\t0/)
        expect((await status('cat /etc/passwd')).code).toBe(0)
        // what only root may do is still refused to a non-root shell, judged by the shell's user
        expect((await status('user add carol')).code).not.toBe(0)
      })
    } finally {
      internals()._programsRunAsUser = gateOpen
    }
  }, 30000)

  it('a child spawned by a user program keeps that user', async () => {
    if (!gateOpen) return
    await asAlice(async () => {
      const result = await status('ecmash -c "cat /proc/self/status"')
      expect(result.code).toBe(0)
      expect(result.out).toMatch(new RegExp(`Uid:\\t${alice.uid}\\t`))
    })
  }, 30000)
})

describe('setuid(2) and the calls like it', () => {
  const ids = (uid: number, euid: number, suid: number) => ({ uid, euid, suid, gid: uid, egid: euid, sgid: suid, groups: [] as number[] })

  it('root sets every id with setuid, and drops them for good', () => {
    const credentials = ids(0, 0, 0)
    expect(setIds(credentials, 'user', 0, 1000, -1, -1)).toBe(0)
    expect([credentials.uid, credentials.euid, credentials.suid]).toEqual([1000, 1000, 1000])
    expect(setIds(credentials, 'user', 0, 0, -1, -1)).toBe(-1)
  })

  it('another user sets setuid only to a real or saved id, and only the effective id changes', () => {
    const credentials = ids(1000, 0, 1000)
    credentials.euid = 1000
    expect(setIds(credentials, 'user', 0, 1001, -1, -1)).toBe(-1)
    expect(setIds(credentials, 'user', 0, 1000, -1, -1)).toBe(0)
    const setuid = ids(1000, 1000, 0)
    expect(setIds(setuid, 'user', 0, 0, -1, -1)).toBe(0)
    expect([setuid.uid, setuid.euid, setuid.suid]).toEqual([1000, 0, 0])
  })

  it('seteuid, as setresuid(-1, e, -1), swaps between the effective and saved ids a setuid program holds', () => {
    const credentials = ids(1000, 0, 0)
    expect(setIds(credentials, 'user', 2, -1, 1000, -1)).toBe(0)
    expect(credentials.euid).toBe(1000)
    expect(setIds(credentials, 'user', 2, -1, 0, -1)).toBe(0)
    expect(credentials.euid).toBe(0)
    // every id is left alone when one is refused
    const plain = ids(1000, 1000, 1000)
    expect(setIds(plain, 'user', 2, 1000, 5, 1000)).toBe(-1)
    expect(plain).toEqual(ids(1000, 1000, 1000))
  })

  it('setreuid saves the new effective id when the real id is set, and the group ids are separate', () => {
    const credentials = ids(0, 0, 0)
    expect(setIds(credentials, 'user', 1, 1000, 1000, -1)).toBe(0)
    expect([credentials.uid, credentials.euid, credentials.suid]).toEqual([1000, 1000, 1000])
    expect([credentials.gid, credentials.egid, credentials.sgid]).toEqual([0, 0, 0])
    expect(setIds(credentials, 'group', 0, 1000, -1, -1)).toBe(-1)
  })
})
