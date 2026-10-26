import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** The commands a Linux user types by reflex: findmnt, mountpoint, lsb_release and the ones the browser cannot do. */
describe('Linux reflex commands', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const run = async (line: string) => {
    const code = await kernel.shell.execute(`${line} > /tmp/o 2> /tmp/e`)
    return { code, out: await fs().readFile('/tmp/o', 'utf-8'), err: await fs().readFile('/tmp/e', 'utf-8') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    // mesg and tty-aware commands need a terminal on standard input
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  describe('findmnt', () => {
    it('lists /proc/mounts with a heading', async () => {
      const { out, code } = await run('findmnt')
      expect(code).toBe(0)
      expect(out.split('\n')[0]).toMatch(/^TARGET\s+SOURCE\s+FSTYPE\s+OPTIONS$/)
      expect(out).toMatch(/^\/proc\s+proc\s+proc\s+rw$/m)
    })

    it('finds one mount by its point, by the path inside it, and by its type', async () => {
      expect((await run('findmnt -n -o TARGET /proc')).out).toBe('/proc\n')
      expect((await run('findmnt -n -o TARGET -T /proc/self')).out).toBe('/proc\n')
      expect((await run('findmnt -n -o TARGET -t proc')).out).toBe('/proc\n')
      expect((await run('findmnt -n -o TARGET -t noproc,sysfs,devtmpfs')).out).not.toContain('/proc')
    })

    it('fails with nothing printed when nothing matches', async () => {
      const result = await run('findmnt /no/such/mount')
      expect(result.code).toBe(1)
      expect(result.out).toBe('')
    })

    it('prints pairs, raw and JSON', async () => {
      expect((await run('findmnt -P -o TARGET,FSTYPE /proc')).out).toBe('TARGET="/proc" FSTYPE="proc"\n')
      expect((await run('findmnt -r -n -o FSTYPE,TARGET /proc')).out).toBe('proc /proc\n')
      expect(JSON.parse((await run('findmnt -J -o TARGET /proc')).out)).toEqual({ filesystems: [{ target: '/proc' }] })
    })

    it('refuses an unknown column', async () => {
      const result = await run('findmnt -o NOPE')
      expect(result.code).toBe(1)
      expect(result.err).toContain('unknown column: NOPE')
    })
  })

  describe('mountpoint', () => {
    it('says whether a path is a mount point, in util-linux wording and statuses', async () => {
      expect(await run('mountpoint /proc')).toMatchObject({ code: 0, out: '/proc is a mountpoint\n' })
      expect(await run('mountpoint /etc')).toMatchObject({ code: 1, out: '/etc is not a mountpoint\n' })
      expect(await run('mountpoint -q /proc')).toMatchObject({ code: 0, out: '' })
      expect(await run('mountpoint /no/such')).toMatchObject({ code: 32, out: '' })
      expect((await run('mountpoint /no/such')).err).toBe('mountpoint: /no/such: No such file or directory\n')
    })

    it('follows a symbolic link unless told not to', async () => {
      await fs().symlink('/proc', '/tmp/to-proc')
      expect((await run('mountpoint /tmp/to-proc')).code).toBe(0)
      expect((await run('mountpoint --nofollow /tmp/to-proc')).code).toBe(1)
      expect((await run('mountpoint --show /tmp/to-proc')).out).toBe('/proc\n')
    })

    it('refuses the device number options it cannot answer', async () => {
      const result = await run('mountpoint -d /proc')
      expect(result.code).toBe(1)
      expect(result.err).toContain('device numbers are not available')
    })
  })

  describe('lsb_release', () => {
    it('reads /etc/os-release', async () => {
      const all = (await run('lsb_release -a')).out
      expect(all).toMatch(/^LSB Version:\tn\/a\nDistributor ID:\tecmaOS\nDescription:\tecmaOS \S+\nRelease:\t\S+\nCodename:\tn\/a\n$/)
      expect((await run('lsb_release -s -i')).out).toBe('ecmaOS\n')
      expect((await run('lsb_release -ds')).out).toMatch(/^ecmaOS \S+\n$/)
      expect((await run('lsb_release -r')).out).toMatch(/^Release:\t\S+\n$/)
    })
  })

  describe('diff3', () => {
    const three = async (mine: string, older: string, yours: string) => {
      await fs().writeFile('/tmp/d3m', mine); await fs().writeFile('/tmp/d3o', older); await fs().writeFile('/tmp/d3y', yours)
    }

    it('lists the blocks as GNU does and exits 0', async () => {
      await three('a\nb\n', 'a\nc\n', 'a\nd\n')
      expect(await run('diff3 /tmp/d3m /tmp/d3o /tmp/d3y')).toEqual({ code: 0, err: '', out: '====\n1:2c\n  b\n2:2c\n  c\n3:2c\n  d\n' })
    })

    it('merges what one side changed and brackets what both did, with status 1', async () => {
      await three('a\nb\nz\n', 'a\nc\nz\n', 'a\nd\nz\n')
      const merged = await run('diff3 -m -L m -L o -L y /tmp/d3m /tmp/d3o /tmp/d3y')
      expect(merged).toEqual({ code: 1, err: '', out: 'a\n<<<<<<< m\nb\n||||||| o\nc\n=======\nd\n>>>>>>> y\nz\n' })
      await three('a\nc\nz\n', 'a\nc\nz\n', 'a\nc\ny\n')
      expect((await run('diff3 -m /tmp/d3m /tmp/d3o /tmp/d3y'))).toEqual({ code: 0, err: '', out: 'a\nc\ny\n' })
    })

    it('reports a missing file and refuses ed scripts', async () => {
      expect(await run('diff3 /tmp/d3m /tmp/d3o /tmp/nope')).toMatchObject({ code: 2, err: 'diff3: /tmp/nope: No such file or directory\n' })
      expect((await run('diff3 -e /tmp/d3m /tmp/d3o /tmp/d3y')).code).toBe(2)
    })
  })

  describe('locate and updatedb', () => {
    it('finds what updatedb saw, by part of a name, a glob, the file name, or a regular expression', async () => {
      await fs().mkdir('/srv/Docs/deep', { recursive: true })
      await fs().writeFile('/srv/Docs/Readme.md', 'x')
      await fs().writeFile('/srv/Docs/deep/notes.txt', 'x')
      expect((await run('updatedb -U /srv -o /tmp/srv.db')).code).toBe(0)
      expect((await run('locate -d /tmp/srv.db notes')).out).toBe('/srv/Docs/deep/notes.txt\n')
      expect((await run('locate -d /tmp/srv.db -i readme')).out).toBe('/srv/Docs/Readme.md\n')
      expect((await run("locate -d /tmp/srv.db '*.md'")).out).toBe('/srv/Docs/Readme.md\n')
      // a glob must match the whole path, and * crosses slashes
      expect((await run("locate -d /tmp/srv.db '/srv/*.md'")).out).toBe('/srv/Docs/Readme.md\n')
      expect((await run("locate -d /tmp/srv.db 'Readme*'")).out).toBe('')
      expect((await run("locate -d /tmp/srv.db -b '*.md'")).out).toBe('/srv/Docs/Readme.md\n')
      expect((await run('locate -d /tmp/srv.db -c Docs')).out).toBe('4\n')
      expect((await run('locate -d /tmp/srv.db -l 1 Docs')).out.split('\n').length).toBe(2)
      expect((await run("locate -d /tmp/srv.db --regex 'txt$'")).out).toBe('/srv/Docs/deep/notes.txt\n')
      expect((await run('locate -d /tmp/srv.db -A Docs notes')).out).toBe('/srv/Docs/deep/notes.txt\n')
      expect((await run('locate -d /tmp/srv.db nothing-like-this')).code).toBe(1)
    })

    it('does not enter /proc or /tmp, and names its default database', async () => {
      expect((await run('updatedb')).code).toBe(0)
      expect((await run('locate /etc/os-release')).out).toBe('/etc/os-release\n')
      expect((await run('locate -c /proc/')).out).toBe('0\n')
      expect((await run('locate -d /no/such.db x')).err).toContain('/no/such.db: No such file or directory (run updatedb)')
      expect((await run('locate')).code).toBe(2)
    })
  })

  describe('ssh-keygen', () => {
    const node = (id: 'node:child_process' | 'node:fs' | 'node:os' | 'node:path') => (process as unknown as { getBuiltinModule: (id: string) => any }).getBuiltinModule(id)

    // OpenSSH's own ssh-keygen reads what ours wrote and says the same about it
    it.each([['ed25519', ''], ['ecdsa', '-b 384'], ['rsa', '-b 2048']])('makes a %s key OpenSSH accepts (%s)', async (type, extra) => {
      const file = `/tmp/key-${type}`
      const made = await run(`ssh-keygen -t ${type} ${extra} -N "" -C test@ecmaos -f ${file}`)
      expect(made.err).toBe('')
      expect(made.code).toBe(0)
      expect(made.out).toContain(`Generating public/private ${type} key pair.`)
      expect(made.out).toContain(`Your identification has been saved in ${file}`)

      expect(((await fs().stat(file)).mode & 0o777).toString(8)).toBe('600')
      const dir = node('node:fs').mkdtempSync(node('node:path').join(node('node:os').tmpdir(), 'sshkey-'))
      node('node:fs').writeFileSync(`${dir}/k`, await fs().readFile(file, 'utf-8'), { mode: 0o600 })
      const host = (...args: string[]) => node('node:child_process').spawnSync('ssh-keygen', args, { encoding: 'utf8' })
      const pub = (await fs().readFile(`${file}.pub`, 'utf-8')).trim()
      expect(host('-y', '-f', `${dir}/k`).stdout.trim()).toBe(pub.replace(' test@ecmaos', ' test@ecmaos'))
      const theirs = host('-l', '-f', `${dir}/k`).stdout.trim()
      expect((await run(`ssh-keygen -l -f ${file}`)).out.trim()).toBe(theirs)
      expect((await run(`ssh-keygen -y -f ${file}`)).out.trim()).toBe(pub)
      expect((await run(`ssh-keygen -l -f ${file}.pub`)).out.trim()).toBe(theirs)
    }, 60000)

    it('defaults to ~/.ssh/id_ed25519, keeps an existing key unless told to overwrite, and refuses a passphrase', async () => {
      await kernel.shell.execute('mkdir -p /home/dflt')
      const made = await run('HOME=/home/dflt ssh-keygen -q -N ""')
      expect(made).toMatchObject({ code: 0, out: '' })
      expect(await fs().exists('/home/dflt/.ssh/id_ed25519.pub')).toBe(true)
      expect((await run('HOME=/home/dflt ssh-keygen -q -N "" < /dev/null')).code).toBe(1)
      expect((await run('ssh-keygen -N secret -f /tmp/no')).err).toContain('passphrases are not supported')
      expect((await run('ssh-keygen -y -f /tmp/missing')).code).toBe(255)
    }, 60000)
  })

  describe('mesg', () => {
    it('shows and changes whether this terminal takes messages, with the exit status', async () => {
      expect(await run('mesg')).toMatchObject({ code: 0, out: 'is y\n' })
      expect((await run('mesg n')).code).toBe(1)
      expect(await run('mesg')).toMatchObject({ code: 1, out: 'is n\n' })
      expect(((await fs().stat('/dev/xterm0')).mode & 0o777).toString(8)).toBe('644')
      expect((await run('mesg y')).code).toBe(0)
      expect(await run('mesg')).toMatchObject({ code: 0, out: 'is y\n' })
      expect((await run('mesg maybe')).code).toBe(2)
    })

    it('lets root wall a terminal that refused messages', async () => {
      await run('mesg n')
      await fs().writeFile('/run/utmp', 'root\ttty0\t0\n')
      const wall = await run('wall hello')
      expect(wall.code).toBe(0)
      await run('mesg y')
    })
  })

  describe('nice and renice', () => {
    it('prints the niceness, adjusts it for a command, and passes it on to what that runs', async () => {
      expect((await run('nice')).out).toBe('0\n')
      expect((await run('nice nice')).out).toBe('10\n')
      expect((await run('nice -n 5 nice')).out).toBe('5\n')
      expect((await run('nice -n 5 nice -n 3 nice')).out).toBe('8\n')
      expect((await run('nice -4 nice')).out).toBe('4\n')
      expect((await run('nice --adjustment=7 nice')).out).toBe('7\n')
      expect((await run('nice -n 99 nice')).out).toBe('19\n')
      expect((await run('nice -n -5 nice')).out).toBe('-5\n')
    })

    it('exits with nice\'s own statuses', async () => {
      expect((await run('nice -n 5')).code).toBe(125)
      expect((await run('nice -n x nice')).code).toBe(125)
      expect((await run('nice no-such-command')).code).toBe(127)
      expect((await run('nice -n 5 sh -c "exit 7"')).code).toBe(7)
    })

    it('renice changes a running process, shown in /proc and by its report', async () => {
      await kernel.shell.execute('sleep 30 &')
      const pids = (await fs().readdir('/proc')).filter(name => /^\d+$/.test(name))
      let target = 0
      for (const pid of pids) if ((await fs().readFile(`/proc/${pid}/cmdline`, 'utf-8').catch(() => '')).includes('sleep')) target = Number(pid)
      expect(target).toBeGreaterThan(0)
      const stat = async () => (await fs().readFile(`/proc/${target}/stat`, 'utf-8')).slice((await fs().readFile(`/proc/${target}/stat`, 'utf-8')).lastIndexOf(')') + 2).split(' ')
      expect((await stat())[16]).toBe('0')
      const done = await run(`renice -n 6 -p ${target}`)
      expect(done).toMatchObject({ code: 0, out: `${target} (process ID) old priority 0, new priority 6\n` })
      const fields = await stat()
      expect(fields.slice(15, 17)).toEqual(['26', '6'])
      expect((await run(`renice 2 ${target}`)).out).toContain('old priority 6, new priority 2')
      expect((await run('renice -n 1 -p 999999')).code).toBe(1)
      expect((await run('renice')).code).toBe(1)
      await run(`kill -9 ${target}`)
    })
  })

  describe('what a browser tab cannot do', () => {
    it.each(['unshare', 'chroot', 'nsenter'])('%s says why and fails', async (name) => {
      const result = await run(`${name} /bin/sh`)
      expect(result.code).toBe(1)
      expect(result.err).toMatch(new RegExp(`^${name}: there (are no namespaces|is no way)`))
      expect((await run(`${name} --version`)).code).toBe(0)
    })
  })
})
