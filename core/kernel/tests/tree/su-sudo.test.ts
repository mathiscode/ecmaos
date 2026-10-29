import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bindContext } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { canRunProgramsAsUser } from '#lib/process-credentials.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `su` and `sudo` are programs with the setuid bit: the kernel starts them with the file owner's (root's)
 * effective id while the real id stays the caller's, and they use that to start something as someone else.
 * That needs programs to run as their user at all, which the published @zenfs/core cannot do, so the tests
 * that rely on it return early there and one asserts the refusal instead.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20000) {
  const start = Date.now()
  while (!await check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('su and sudo', () => {
  let kernel: Kernel
  const screen = () => {
    const buffer = kernel.terminal.buffer.active
    let text = ''
    for (let i = 0; i < buffer.length; i++) text += (buffer.getLine(i)?.translateToString(true) ?? '') + '\n'
    return text
  }
  const prompts = () => screen().split('Password: ').length - 1
  // the prompt is drawn on the terminal even when the command's own output is redirected
  let alice: { uid: number, gid: number }
  let bob: { uid: number, gid: number }
  let gateOpen = false

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
  const asBob = (run: () => Promise<void>) => asUser(bob, '/home/bob', run)

  /** Runs a command, collecting what it printed; each user has their own files, as the others would not be writable. */
  const status = async (command: string) => {
    const mine = `/tmp/ss-${kernel.shell.credentials.uid}`
    await kernel.filesystem.fs.unlink(`${mine}-out`).catch(() => {})
    await kernel.filesystem.fs.unlink(`${mine}-err`).catch(() => {})
    const code = await kernel.shell.execute(`${command} > ${mine}-out 2> ${mine}-err`)
    const read = (name: string) => kernel.filesystem.fs.readFile(`${mine}-${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }
  const setSudoers = (text: string) => kernel.filesystem.fs.writeFile('/etc/sudoers', text, { mode: 0o440 })
  const uidLine = (uid: number) => new RegExp(`Uid:\\t${uid}\\t${uid}\\t${uid}\\t${uid}`)

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    // jsdom defines `ontouchstart`, which makes the terminal think it is a phone and keep the old key path;
    // the line discipline a program reads a password from is the desktop one (see tty-input.test.ts)
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
    await kernel.users.add({ username: 'alice', password: 'wonder', home: '/home/alice', shell: '/bin/ecmash' })
    await kernel.users.add({ username: 'bob', password: 'builder', home: '/home/bob', shell: '/bin/ecmash' })
    const named = (name: string) => [...(kernel.users.all as Map<number, { uid: number, gid: number, username: string }>).values()].find(u => u.username === name)!
    alice = named('alice')
    bob = named('bob')
    gateOpen = await canRunProgramsAsUser(kernel.filesystem.fs)
  }, 60000)

  beforeEach(async () => {
    await kernel.filesystem.fs.rm('/run/sudo', { recursive: true, force: true }).catch(() => {})
    await setSudoers('Defaults timestamp_timeout=5\nroot ALL=(ALL) ALL\nalice ALL=(ALL) ALL\n')
  })

  describe('files', () => {
    it('su and sudo carry the setuid bit and the sudoers file is private', async () => {
      for (const path of ['/bin/su', '/bin/sudo']) {
        const stats = await kernel.filesystem.fs.stat(path)
        expect(stats.mode & 0o7777, path).toBe(0o4755)
        expect(stats.uid).toBe(0)
      }
      expect((await kernel.filesystem.fs.stat('/etc/sudoers')).mode & 0o7777).toBe(0o440)
    })

    it('a fresh sudoers file lets root and the sudo group in', async () => {
      const { DEFAULT_SUDOERS } = await import('@ecmaos/coreutils/lib/sudoers')
      expect(DEFAULT_SUDOERS).toMatch(/^root\s+ALL=\(ALL:ALL\) ALL$/m)
      expect(DEFAULT_SUDOERS).toMatch(/^%sudo\s+ALL=\(ALL:ALL\) ALL$/m)
    })

    it('boots with the sudo group that the default sudoers file grants, and the group is in /etc/group', async () => {
      expect(kernel.users.findGroup('sudo')?.gid).toBe(27)
      expect(await kernel.filesystem.fs.readFile('/etc/group', 'utf-8')).toMatch(/^sudo:x:27:/m)
      // asking again changes nothing
      expect((await kernel.users.ensureGroup('sudo', 99)).gid).toBe(27)
    })
  })

  describe('the setuid bit', () => {
    const probe = '/tmp/suid-probe.js'
    beforeAll(async () => {
      await kernel.filesystem.fs.writeFile(probe, `
        const s = globalThis.ecmaosSyscalls
        s.writeAll(1, new TextEncoder().encode(s.getuid() + ' ' + s.geteuid() + '\\n'))
        s.exit(0)
      `, { mode: 0o755 })
    })

    it('a program owned by root with the bit runs as root for whoever starts it, keeping their real id', async () => {
      if (!gateOpen) return
      await kernel.filesystem.fs.chmod(probe, 0o4755)
      await asAlice(async () => {
        const result = await status(probe)
        expect(result.out).toBe(`${alice.uid} 0\n`)
      })
    }, 60000)

    it('without the bit it runs as the user, and a user\'s own copy gains nothing', async () => {
      if (!gateOpen) return
      await kernel.filesystem.fs.chmod(probe, 0o755)
      await asAlice(async () => {
        expect((await status(probe)).out).toBe(`${alice.uid} ${alice.uid}\n`)
        // a copy is the user's own file; the bit on it names the user, who gains nothing
        expect((await status('cp /tmp/suid-probe.js /tmp/alice-probe.js')).code).toBe(0)
        expect((await status('chmod 4755 /tmp/alice-probe.js')).code).toBe(0)
        expect((await status('/tmp/alice-probe.js')).out).toBe(`${alice.uid} ${alice.uid}\n`)
      })
    }, 60000)

    it('a user\'s program cannot ask the kernel to check a password', async () => {
      if (!gateOpen) return
      await kernel.filesystem.fs.writeFile('/tmp/auth-probe.js', `
        const s = globalThis.ecmaosSyscalls
        let text
        try { text = String(await s.custom('users_authenticate', 'root', 'root')) } catch (error) { text = String(error?.message ?? error) }
        s.writeAll(1, new TextEncoder().encode(text))
        s.exit(0)
      `, { mode: 0o755 })
      await asAlice(async () => {
        expect((await status('/tmp/auth-probe.js')).out).toMatch(/not permitted/i)
      })
    }, 60000)
  })

  describe('where programs cannot run as a user', () => {
    it('refuse, rather than give root to anyone', async () => {
      if (gateOpen) return
      for (const command of ['sudo id', 'su alice -c id']) {
        const result = await status(command)
        expect(result.code, command).toBe(1)
        expect(result.err, command).toMatch(/@zenfs\/core/)
      }
    }, 60000)
  })

  describe('sudoedit', () => {
    // an editor that appends the id of whoever runs it to the file it is given, or does nothing with FAKE_EDITOR_NOOP
    const editor = '/tmp/fake-editor.js'
    beforeAll(async () => {
      await kernel.filesystem.fs.writeFile(editor, `
        const s = globalThis.ecmaosSyscalls
        const file = s.argv[1]
        if (!s.env.FAKE_EDITOR_NOOP) {
          const fd = s.open(file, s.O_WRONLY | 0o2000)
          s.writeAll(fd, new TextEncoder().encode('edited by uid ' + s.getuid() + '\\n'))
          s.close(fd)
        }
        s.exit(Number(s.env.FAKE_EDITOR_EXIT ?? 0))
      `, { mode: 0o755 })
      await kernel.filesystem.fs.writeFile('/etc/sudoedit-target', 'original\n', { mode: 0o644 })
    })

    it('carries the setuid bit like sudo', async () => {
      const stats = await kernel.filesystem.fs.stat('/bin/sudoedit')
      expect(stats.mode & 0o7777).toBe(0o4755)
      expect(stats.uid).toBe(0)
    })

    it('edits a root file in a copy the user owns, and writes it back as root', async () => {
      if (!gateOpen) return
      await kernel.filesystem.fs.writeFile('/etc/sudoedit-target', 'original\n', { mode: 0o644 })
      await asAlice(async () => {
        const result = await status(`echo wonder | SUDO_EDITOR=${editor} sudoedit -S /etc/sudoedit-target`)
        expect(result.err).not.toContain('not permitted')
        expect(result.code).toBe(0)
      })
      // the editor ran as alice, not as root, and the file is still root's
      expect(await kernel.filesystem.fs.readFile('/etc/sudoedit-target', 'utf-8')).toBe(`original\nedited by uid ${alice.uid}\n`)
      const stats = await kernel.filesystem.fs.stat('/etc/sudoedit-target')
      expect([stats.uid, stats.mode & 0o777]).toEqual([0, 0o644])
      // nothing is left in /tmp
      expect((await kernel.filesystem.fs.readdir('/tmp')).filter(name => name.startsWith('sudoedit.'))).toEqual([])
    }, 90000)

    it('sudo -e is the same, and a file nobody changed or an editor that failed is left alone', async () => {
      if (!gateOpen) return
      await kernel.filesystem.fs.writeFile('/etc/sudoedit-target', 'original\n', { mode: 0o644 })
      await asAlice(async () => {
        const unchanged = await status(`echo wonder | FAKE_EDITOR_NOOP=1 SUDO_EDITOR=${editor} sudo -S -e /etc/sudoedit-target`)
        expect([unchanged.code, unchanged.err]).toEqual([0, expect.stringContaining('/etc/sudoedit-target unchanged')])
        const failed = await status(`FAKE_EDITOR_EXIT=3 SUDO_EDITOR=${editor} sudo -n -e /etc/sudoedit-target`)
        expect(failed.code).toBe(1)
        expect(failed.err).toContain('not updated')
      })
      expect(await kernel.filesystem.fs.readFile('/etc/sudoedit-target', 'utf-8')).toBe('original\n')
    }, 90000)

    it('refuses a file in a directory the user can write to, a symbolic link, and a user the policy does not name', async () => {
      if (!gateOpen) return
      await kernel.filesystem.fs.writeFile('/tmp/sudoedit-tmpfile', 'x\n')
      await kernel.filesystem.fs.symlink('/etc/sudoedit-target', '/etc/sudoedit-link').catch(() => {})
      await asAlice(async () => {
        const writable = await status(`echo wonder | SUDO_EDITOR=${editor} sudoedit -S /tmp/sudoedit-tmpfile`)
        expect(writable.code).toBe(1)
        expect(writable.err).toContain('editing files in a writable directory is not permitted')
        const link = await status(`echo wonder | SUDO_EDITOR=${editor} sudoedit -S /etc/sudoedit-link`)
        expect(link.code).toBe(1)
        expect(link.err).toContain('symbolic links')
      })
      await asBob(async () => {
        const result = await status(`echo builder | SUDO_EDITOR=${editor} sudoedit -S /etc/sudoedit-target`)
        expect(result.code).toBe(1)
        expect(result.err).toContain('bob is not in the sudoers file')
      })
    }, 90000)
  })

  describe('sudo', () => {
    it('asks for the caller\'s own password and runs the command as root', async () => {
      if (!gateOpen) return
      await asAlice(async () => {
        const result = await status('echo wonder | sudo -S cat /proc/self/status')
        expect(result.code).toBe(0)
        expect(result.out).toMatch(uidLine(0))
        expect(result.err).toContain('[sudo] password for alice:')
      })
    }, 60000)

    it('refuses a wrong password', async () => {
      if (!gateOpen) return
      await asAlice(async () => {
        const result = await status('echo builder | sudo -S cat /proc/self/status')
        expect(result.code).toBe(1)
        expect(result.out).toBe('')
        expect(result.err).toContain('Sorry, try again.')
      })
    }, 60000)

    it('remembers the password for a while, and -k forgets it', async () => {
      if (!gateOpen) return
      await asAlice(async () => {
        expect((await status('sudo -n id')).err).toContain('a password is required')
        expect((await status('echo wonder | sudo -S id')).code).toBe(0)
        expect((await status('sudo -n id')).code).toBe(0)
        expect((await status('sudo -k')).code).toBe(0)
        expect((await status('sudo -n id')).code).toBe(1)
      })
    }, 90000)

    it('never remembers it with timestamp_timeout=0', async () => {
      if (!gateOpen) return
      await setSudoers('Defaults timestamp_timeout=0\nalice ALL=(ALL) ALL\n')
      await asAlice(async () => {
        expect((await status('echo wonder | sudo -S id')).code).toBe(0)
        expect((await status('sudo -n id')).code).toBe(1)
      })
    }, 60000)

    it('^Z stops sudo and what it runs, and fg carries on', async () => {
      if (!gateOpen) return
      await setSudoers('alice ALL=(ALL) NOPASSWD: ALL\n')
      await asAlice(async () => {
        const run = kernel.shell.execute('sudo sleep 8')
        await waitFor(() => (kernel.shell.foregroundJob?.processes.length ?? 0) > 0)
        const job = kernel.shell.foregroundJob!
        // let sudo get as far as starting its child
        await new Promise(r => setTimeout(r, 1500))
        kernel.terminal.input('\x1a', true)
        await waitFor(() => { if (job.status === 'done') throw new Error('job already done'); return job.status === 'stopped' }, 5000)
        const fg = kernel.shell.fg()
        expect(await Promise.race([fg.then(() => 'done'), new Promise(r => setTimeout(() => r('hung'), 15000))])).toBe('done')
        expect(await run).toBe(0)
      })
    }, 60000)

    it('refuses a user the file does not name', async () => {
      if (!gateOpen) return
      await asBob(async () => {
        const result = await status('echo builder | sudo -S id')
        expect(result.code).toBe(1)
        expect(result.err).toContain('bob is not in the sudoers file')
      })
    }, 60000)

    it('lets NOPASSWD skip the password, for the commands named only', async () => {
      if (!gateOpen) return
      await setSudoers('alice ALL=(root) NOPASSWD: /bin/cat\n')
      await asAlice(async () => {
        const allowed = await status('sudo -n cat /etc/shadow')
        expect(allowed.code).toBe(0)
        expect(allowed.out).toContain('root:')
        const refused = await status('sudo -n ls /')
        expect(refused.code).toBe(1)
        expect(refused.err).toMatch(/not allowed to run '\/bin\/ls \/' as root/)
      })
    }, 60000)

    it('runs as the user named by -u when the rule allows that user, and no other', async () => {
      if (!gateOpen) return
      await setSudoers('alice ALL=(bob) NOPASSWD: ALL\n')
      await asAlice(async () => {
        const result = await status('sudo -n -u bob cat /proc/self/status')
        expect(result.out).toMatch(uidLine(bob.uid))
        const refused = await status('sudo -n id')
        expect(refused.code).toBe(1)
        expect(refused.err).toMatch(/as root/)
        expect((await status('sudo -n -u nobody-here id')).err).toContain('unknown user')
      })
    }, 60000)

    it('says who asked, and sets the target\'s HOME and USER', async () => {
      if (!gateOpen) return
      await setSudoers('alice ALL=(root) NOPASSWD: ALL\n')
      await asAlice(async () => {
        expect((await status('sudo -n printenv SUDO_USER')).out).toBe('alice\n')
        expect((await status('sudo -n printenv USER')).out).toBe('root\n')
        expect((await status('sudo -n printenv HOME')).out).toBe('/root\n')
        expect((await status('sudo -n printenv SUDO_COMMAND')).out).toBe('/bin/printenv SUDO_COMMAND\n')
      })
    }, 60000)

    it('passes the exit status of the command on', async () => {
      if (!gateOpen) return
      await setSudoers('alice ALL=(root) NOPASSWD: ALL\n')
      await asAlice(async () => {
        expect((await status('sudo -n sh -c "exit 7"')).code).toBe(7)
        expect((await status('sudo -n no-such-command')).code).toBe(1)
      })
    }, 60000)

    it('runs a shell with -i, in the target\'s home, and a command through it', async () => {
      if (!gateOpen) return
      await setSudoers('alice ALL=(root) NOPASSWD: ALL\n')
      await asAlice(async () => {
        expect((await status('sudo -n -i pwd')).out).toBe('/root\n')
        expect((await status('sudo -n -s cat /proc/self/status')).out).toMatch(uidLine(0))
      })
    }, 60000)

    it('lists what the caller may run', async () => {
      if (!gateOpen) return
      await setSudoers('alice ALL=(root) NOPASSWD: /bin/cat, !/bin/rm\n')
      await asAlice(async () => {
        const result = await status('sudo -l')
        expect(result.code).toBe(0)
        expect(result.out).toContain('(root) NOPASSWD: /bin/cat')
        expect(result.out).toContain('(root) NOPASSWD: !/bin/rm')
      })
    }, 60000)

    it('reads rules from /etc/sudoers.d, but not from a file others may write', async () => {
      if (!gateOpen) return
      await setSudoers('root ALL=(ALL) ALL\n@includedir /etc/sudoers.d\n')
      await kernel.filesystem.fs.writeFile('/etc/sudoers.d/alice', 'alice ALL=(root) NOPASSWD: /bin/cat\n', { mode: 0o440 })
      await kernel.filesystem.fs.writeFile('/etc/sudoers.d/open', 'alice ALL=(root) NOPASSWD: ALL\n', { mode: 0o666 })
      await kernel.filesystem.fs.writeFile('/etc/sudoers.d/alice.bak', 'alice ALL=(root) NOPASSWD: ALL\n', { mode: 0o440 })
      try {
        await asAlice(async () => {
          const listed = await status('sudo -l')
          expect(listed.out).toContain('(root) NOPASSWD: /bin/cat')
          expect(listed.out).not.toContain('NOPASSWD: ALL')
          expect(listed.err).toContain('/etc/sudoers.d/open is world writable')
          expect((await status('sudo -n cat /proc/self/status')).out).toMatch(uidLine(0))
          expect((await status('sudo -n id')).code).not.toBe(0)
        })
      } finally {
        for (const name of ['alice', 'open', 'alice.bak']) await kernel.filesystem.fs.rm(`/etc/sudoers.d/${name}`)
      }
    }, 60000)

    it('does not ask root for a password, and lets root run as someone else', async () => {
      if (!gateOpen) return
      const result = await status('sudo -n -u alice cat /proc/self/status')
      expect(result.code).toBe(0)
      expect(result.out).toMatch(uidLine(alice.uid))
    }, 60000)

    it('refuses with no sudoers file at all', async () => {
      if (!gateOpen) return
      await kernel.filesystem.fs.rm('/etc/sudoers')
      await asAlice(async () => {
        expect((await status('sudo -n id')).err).toContain('/etc/sudoers')
      })
    }, 60000)
  })

  describe('su', () => {
    it('lets root become anyone without a password, in a shell that runs as them', async () => {
      if (!gateOpen) return
      const result = await status('su alice -c "cat /proc/self/status"')
      expect(result.code).toBe(0)
      expect(result.out).toMatch(uidLine(alice.uid))
      expect(result.err).not.toContain('Password')
    }, 60000)

    it('sets HOME and USER, and with - starts in the home directory', async () => {
      if (!gateOpen) return
      expect((await status("su bob -c 'echo $HOME $USER'")).out).toBe('/home/bob bob\n')
      expect((await status('su - bob -c pwd')).out).toBe('/home/bob\n')
    }, 60000)

    it('reports an unknown user, and passes the status of the command on', async () => {
      if (!gateOpen) return
      const missing = await status('su nobody-here -c id')
      expect(missing.code).toBe(1)
      expect(missing.err).toContain('user nobody-here does not exist')
      expect((await status('su alice -c "exit 5"')).code).toBe(5)
    }, 60000)

    it('is a child: what it runs does not change the shell it came from', async () => {
      if (!gateOpen) return
      await status('su alice -c "cd /tmp"')
      expect(kernel.shell.cwd).not.toBe('/tmp')
      expect(kernel.shell.credentials.uid).toBe(0)
      expect((await status('cat /proc/self/status')).out).toMatch(uidLine(0))
    }, 60000)

    it('asks anyone else for the password of the user they become', async () => {
      if (!gateOpen) return
      await asAlice(async () => {
        const before = prompts()
        const run = status('su bob -c "cat /proc/self/status"')
        await waitFor(() => prompts() > before)
        kernel.terminal.input('builder\r', true)
        const result = await run
        expect(result.code).toBe(0)
        expect(result.out).toMatch(uidLine(bob.uid))
      })
    }, 60000)

    it('refuses a wrong password', async () => {
      if (!gateOpen) return
      await asAlice(async () => {
        const before = prompts()
        const run = status('su bob -c "cat /proc/self/status"')
        await waitFor(() => prompts() > before)
        kernel.terminal.input('wonder\r', true)
        const result = await run
        expect(result.code).toBe(1)
        expect(result.err).toContain('Authentication failure')
        expect(result.out).not.toMatch(/Uid/)
      })
    }, 60000)
  })
})
