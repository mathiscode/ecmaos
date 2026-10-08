import { beforeAll, describe, expect, it } from 'vitest'
import { bindContext } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { canRunProgramsAsUser } from '#lib/process-credentials.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** useradd, userdel, usermod, groupadd, groupdel, groupmod, gpasswd and visudo, and the group registry under them. */
describe('account commands', () => {
  let kernel: Kernel
  let serial = 0
  const fs = () => kernel.filesystem.fs

  const sh = async (command: string) => {
    const base = `/tmp/ac-${serial++}`
    const code = await kernel.shell.execute(`${command} > ${base}.out 2> ${base}.err`)
    const read = (suffix: string) => fs().readFile(`${base}.${suffix}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }
  const group = async (name: string) => (await sh(`getent group ${name}`)).out.trim()
  const passwd = async (name: string) => (await sh(`getent passwd ${name}`)).out.trim()

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  describe('groupadd, groupmod and groupdel', () => {
    it('creates a group with the first free id from 1000, and lists it', async () => {
      expect((await sh('groupadd staff')).code).toBe(0)
      expect(await group('staff')).toMatch(/^staff:x:1000:$/)
      expect((await sh('groupadd crew')).code).toBe(0)
      expect(await group('crew')).toMatch(/^crew:x:1001:$/)
    }, 30000)

    it('takes an id with -g, and a system id from 100 with -r', async () => {
      await sh('groupadd -g 2500 pinned')
      expect(await group('pinned')).toBe('pinned:x:2500:')
      await sh('groupadd -r daemons')
      expect(await group('daemons')).toMatch(/^daemons:x:1\d\d:$/)
    }, 30000)

    it('refuses a duplicate name or id, a bad name or id, and -f makes a duplicate harmless', async () => {
      const dup = await sh('groupadd staff')
      expect(dup.code).toBe(1)
      expect(dup.err).toContain("group 'staff' already exists")
      expect((await sh('groupadd -g 2500 other')).err).toContain("GID '2500' already exists")
      expect((await sh('groupadd "bad name"')).code).toBe(1)
      expect((await sh('groupadd -g abc x')).code).toBe(3)
      expect((await sh('groupadd -f staff')).code).toBe(0)
      expect((await sh('groupadd')).code).toBe(2)
    }, 30000)

    it('renames a group and gives it another id', async () => {
      await sh('groupadd movers')
      expect((await sh('groupmod -n shakers movers')).code).toBe(0)
      expect(await group('shakers')).toMatch(/^shakers:x:\d+:$/)
      expect((await sh('getent group movers')).code).toBe(2)
      expect((await sh('groupmod -g 3100 shakers')).code).toBe(0)
      expect(await group('shakers')).toBe('shakers:x:3100:')
      const clash = await sh('groupmod -g 2500 shakers')
      expect(clash.code).toBe(1)
      expect(clash.err).toContain('already exists')
      expect((await sh('groupmod shakers')).err).toContain('no changes specified')
      expect((await sh('groupmod -n x nope')).code).toBe(1)
    }, 30000)

    it('deletes a group, and says when there is none', async () => {
      await sh('groupadd doomed')
      expect((await sh('groupdel doomed')).code).toBe(0)
      expect((await sh('getent group doomed')).code).toBe(2)
      const missing = await sh('groupdel doomed')
      expect(missing.code).toBe(1)
      expect(missing.err).toContain('does not exist')
    }, 30000)
  })

  describe('useradd', () => {
    it('creates an account with a group of its own, and a password that works', async () => {
      const result = await sh('useradd -m -p secret1 carol')
      expect(result.code).toBe(0)
      const entry = await passwd('carol')
      expect(entry).toMatch(/^carol:x:\d+:\d+:carol:\/home\/carol:ecmaos$/)
      const uid = Number(entry.split(':')[2])
      const gid = Number(entry.split(':')[3])
      expect(uid).toBeGreaterThanOrEqual(1000)
      // the group is named after the user; it has the uid as its gid only when that gid is free
      expect(await group('carol')).toBe(`carol:x:${gid}:`)
      const home = await fs().stat('/home/carol')
      expect(home.uid).toBe(uid)
      expect(home.mode & 0o777).toBe(0o750)
      await expect(kernel.users.login('carol', 'secret1')).resolves.toBeDefined()
      await expect(kernel.users.login('carol', 'wrong')).rejects.toThrow()
      expect(await fs().readFile('/etc/shadow', 'utf-8')).toContain('carol:')
    }, 30000)

    it('id and groups name another user and its groups, not the caller\'s', async () => {
      await sh('groupadd idsquad')
      await sh('useradd -p secret1 -G idsquad idtest')
      const named = (await sh('id idtest')).out.trim()
      const uid = (await passwd('idtest')).split(':')[2]
      expect(named).toMatch(new RegExp(`^uid=${uid} gid=\\d+ groups=`))
      expect(named).not.toBe((await sh('id')).out.trim())
      expect((await sh('id -Gn idtest')).out.trim().split(' ')).toEqual(expect.arrayContaining(['idtest', 'idsquad']))
      expect((await sh('groups idtest')).out.trim()).toMatch(/^idtest : idtest( \w+)*$/)
      expect((await sh('groups idtest')).out).toContain('idsquad')
      expect((await sh('id nosuchuser')).code).toBe(1)
    }, 30000)

    it('does not make a home directory unless asked', async () => {
      await sh('useradd -p secret1 nohome')
      expect(await fs().exists('/home/nohome')).toBe(false)
      await sh('useradd -m -d /srv/dave -p secret1 dave')
      expect(await fs().exists('/srv/dave')).toBe(true)
      expect(await passwd('dave')).toContain(':/srv/dave:')
    }, 30000)

    it('puts the user in the groups it is told to', async () => {
      await sh('useradd -p secret1 -G staff,crew erin')
      expect(await group('staff')).toContain(':erin')
      expect(await group('crew')).toContain(':erin')
      await sh('useradd -p secret1 -g staff frank')
      const entry = (await passwd('frank')).split(':')
      expect(entry[3]).toBe('1000')
      // a user's primary group is not a new group named after them when one was named
      expect((await sh('getent group frank')).code).toBe(2)
    }, 30000)

    it('takes a uid and a shell, and makes a system account below 1000', async () => {
      await sh('useradd -p secret1 -u 4242 -s /bin/ecmash gina')
      expect(await passwd('gina')).toMatch(/^gina:x:4242:\d+:gina:\/home\/gina:\/bin\/ecmash$/)
      await sh('useradd -p secret1 -r svc')
      expect(Number((await passwd('svc')).split(':')[2])).toBeLessThan(1000)
    }, 30000)

    it('refuses a duplicate, an unknown group, a taken uid, a bad name and a bad id', async () => {
      expect((await sh('useradd -p secret1 carol')).err).toContain("user 'carol' already exists")
      expect((await sh('useradd -p secret1 -G nosuchgroup hal')).err).toContain("group 'nosuchgroup' does not exist")
      expect((await sh('useradd -p secret1 -g nosuchgroup hal')).code).toBe(1)
      expect((await sh('useradd -p secret1 -u 4242 hal')).err).toContain('not unique')
      expect((await sh('useradd -p secret1 -u x hal')).code).toBe(3)
      expect((await sh('useradd -p abc hal2')).err).toMatch(/at least 4/)
      expect((await sh('useradd')).code).toBe(2)
      // nothing is left behind by a failed attempt
      expect((await sh('getent group hal')).code).toBe(2)
      expect((await sh('getent passwd hal')).code).toBe(2)
    }, 60000)
  })

  describe('usermod', () => {
    beforeAll(async () => {
      await sh('useradd -m -p secret1 mallory')
      await fs().writeFile('/home/mallory/note.txt', 'x')
      await fs().chown('/home/mallory/note.txt', kernel.users.byName('mallory')!.uid, 0)
    }, 30000)

    it('adds supplementary groups, and with -G alone replaces them', async () => {
      expect((await sh('usermod -aG staff,crew mallory')).code).toBe(0)
      expect(await group('staff')).toContain('mallory')
      expect(await group('crew')).toContain('mallory')
      expect((await sh('usermod -G crew mallory')).code).toBe(0)
      expect(await group('staff')).not.toContain('mallory')
      expect(await group('crew')).toContain('mallory')
    }, 30000)

    it('changes the shell and the primary group', async () => {
      await sh('usermod -s /bin/ecmash -g staff mallory')
      const entry = (await passwd('mallory')).split(':')
      expect(entry[6]).toBe('/bin/ecmash')
      expect(entry[3]).toBe('1000')
    }, 30000)

    it('renames the user everywhere, including the private group, and the password still works', async () => {
      await sh('useradd -m -p secret1 oldname')
      const [, , uid, gid] = (await passwd('oldname')).split(':')
      expect((await sh('usermod -l newname oldname')).code).toBe(0)
      expect((await sh('getent passwd oldname')).code).toBe(2)
      expect(await passwd('newname')).toMatch(new RegExp(`^newname:x:${uid}:`))
      expect(await group('newname')).toBe(`newname:x:${gid}:`)
      expect((await sh('getent group oldname')).code).toBe(2)
      const shadow = await fs().readFile('/etc/shadow', 'utf-8')
      expect(shadow).toContain('newname:')
      expect(shadow).not.toContain('oldname:')
      await expect(kernel.users.login('newname', 'secret1')).resolves.toBeDefined()
    }, 30000)

    it('gives a new uid and hands the home directory over', async () => {
      expect((await sh('usermod -u 5555 mallory')).code).toBe(0)
      expect((await passwd('mallory')).split(':')[2]).toBe('5555')
      expect((await fs().stat('/home/mallory')).uid).toBe(5555)
      expect((await fs().stat('/home/mallory/note.txt')).uid).toBe(5555)
      await expect(kernel.users.login('mallory', 'secret1')).resolves.toBeDefined()
    }, 30000)

    it('moves the home directory with -d -m', async () => {
      expect((await sh('usermod -d /home/moved -m mallory')).code).toBe(0)
      expect(await fs().exists('/home/moved/note.txt')).toBe(true)
      expect(await fs().exists('/home/mallory')).toBe(false)
      expect(await passwd('mallory')).toContain(':/home/moved:')
    }, 30000)

    it('refuses what cannot be done', async () => {
      expect((await sh('usermod -s /x nobody-here')).err).toContain('does not exist')
      expect((await sh('usermod mallory')).err).toContain('no changes specified')
      expect((await sh('usermod -l carol mallory')).err).toContain('already exists')
      expect((await sh('usermod -u 4242 mallory')).err).toContain('already exists')
      expect((await sh('usermod -G nosuchgroup mallory')).err).toContain('does not exist')
      expect((await sh('usermod -a mallory')).code).toBe(2)
      expect((await sh('usermod -m mallory')).code).toBe(2)
      expect((await sh('usermod -L mallory')).code).toBe(2)
    }, 60000)
  })

  describe('gpasswd', () => {
    it('adds and removes members, and can set the whole list', async () => {
      await sh('groupadd team')
      expect((await sh('gpasswd -a carol team')).code).toBe(0)
      expect((await sh('gpasswd -a dave team')).code).toBe(0)
      expect(await group('team')).toMatch(/:(carol,dave|dave,carol)$/)
      expect((await sh('gpasswd -d carol team')).code).toBe(0)
      expect(await group('team')).toMatch(/:dave$/)
      expect((await sh('gpasswd -M carol,erin team')).code).toBe(0)
      expect(await group('team')).toMatch(/:(carol,erin|erin,carol)$/)
    }, 30000)

    it('refuses an unknown user or group, and a missing action', async () => {
      expect((await sh('gpasswd -a nobody-here team')).err).toContain('does not exist')
      expect((await sh('gpasswd -a carol nogroup')).err).toContain('does not exist')
      expect((await sh('gpasswd team')).code).toBe(2)
    }, 30000)
  })

  describe('shadow commands', () => {
    const shadowLine = async (name: string) => (await fs().readFile('/etc/shadow', 'utf-8')).split('\n').find(line => line.startsWith(`${name}:`)) ?? ''

    it('useradd -r makes a system account with * and no prompt, and -p gives it a password anyway', async () => {
      expect((await sh('useradd -r nologinsvc')).code).toBe(0)
      expect((await shadowLine('nologinsvc')).split(':')[1]).toBe('*')
      expect((await sh('passwd -S nologinsvc')).out).toMatch(/^nologinsvc L \d{4}-\d{2}-\d{2} 0 99999 7 -1$/m)
      await sh('useradd -r -p secret1 withpass')
      expect((await shadowLine('withpass')).split(':')[1]).toMatch(/^\$pbkdf2-sha256\$/)
      await expect(kernel.users.login('nologinsvc', '*')).rejects.toThrow()
    }, 30000)

    it('passwd -l locks, -u unlocks, -S says which', async () => {
      await sh('useradd -p secret1 lockme')
      expect((await sh('passwd -S lockme')).out).toMatch(/^lockme P /)
      expect((await sh('passwd -l lockme')).code).toBe(0)
      expect((await shadowLine('lockme')).split(':')[1]).toMatch(/^!\$pbkdf2-sha256\$/)
      expect((await sh('passwd -S lockme')).out).toMatch(/^lockme L /)
      await expect(kernel.users.login('lockme', 'secret1')).rejects.toThrow()
      expect((await sh('passwd -u lockme')).code).toBe(0)
      expect((await sh('passwd -S lockme')).out).toMatch(/^lockme P /)
      expect((await kernel.users.login('lockme', 'secret1')).user.username).toBe('lockme')
    }, 60000)

    it('passwd -l and -u refuse an unknown account and a bad command line', async () => {
      expect((await sh('passwd -l nosuchuser')).err).toContain("user 'nosuchuser' does not exist")
      expect((await sh('passwd -l')).code).toBe(2)
      expect((await sh('passwd -l -u lockme')).code).toBe(2)
      expect((await sh('passwd -x lockme')).code).toBe(2)
    }, 30000)

    it('chage sets the aging fields in the shadow file, and -l lists them', async () => {
      await sh('useradd -p secret1 aged')
      expect((await sh('chage -M 90 -W 14 -m 1 aged')).code).toBe(0)
      expect((await shadowLine('aged')).split(':').slice(3, 6)).toEqual(['1', '90', '14'])
      expect((await sh('chage -E 2030-01-01 -I 5 aged')).code).toBe(0)
      expect((await shadowLine('aged')).split(':').slice(6, 8)).toEqual(['5', '21915'])
      const listed = (await sh('chage -l aged')).out
      expect(listed).toContain('Account expires')
      expect(listed).toMatch(/Account expires\s+: 2030-01-01/)
      expect(listed).toMatch(/Maximum number of days between password change\s+: 90/)
      expect((await sh('chage -E -1 -I -1 aged')).code).toBe(0)
      expect((await shadowLine('aged')).split(':').slice(6, 8)).toEqual(['', ''])
    }, 60000)

    it('chage refuses what it cannot read', async () => {
      expect((await sh('chage -M abc aged')).code).toBe(1)
      expect((await sh('chage -E 2030-13-45 aged')).code).toBe(1)
      expect((await sh('chage nosuchuser -M 5')).err).toContain("user 'nosuchuser' does not exist")
      expect((await sh('chage aged')).code).toBe(2)
      expect((await sh('chage')).code).toBe(2)
    }, 30000)

    it('an expired account cannot log in', async () => {
      await sh('chage -E 1970-01-02 aged')
      await expect(kernel.users.login('aged', 'secret1')).rejects.toThrow(/account has expired/)
    }, 30000)
  })

  describe('userdel', () => {
    it('removes the account, its private group and its shadow line, and leaves the home', async () => {
      await sh('useradd -m -p secret1 victim')
      const uid = (await passwd('victim')).split(':')[2]
      expect((await sh('userdel victim')).code).toBe(0)
      expect((await sh('getent passwd victim')).code).toBe(2)
      expect((await sh('getent group victim')).code).toBe(2)
      expect(await fs().readFile('/etc/shadow', 'utf-8')).not.toContain('victim:')
      expect(await fs().exists('/home/victim')).toBe(true)
      expect(uid).toMatch(/^\d+$/)
    }, 30000)

    it('removes the home directory with -r', async () => {
      await sh('useradd -m -p secret1 gone')
      await fs().writeFile('/home/gone/file', 'x')
      await fs().mkdir('/home/gone/dir')
      expect((await sh('userdel -r gone')).code).toBe(0)
      expect(await fs().exists('/home/gone')).toBe(false)
    }, 30000)

    it('keeps a group other people are in, and takes the user out of the groups it was in', async () => {
      await sh('useradd -p secret1 sharer')
      await sh('useradd -p secret1 -g sharer sharer2')
      await sh('userdel sharer')
      expect((await sh('getent group sharer')).code).toBe(0)
      await sh('useradd -p secret1 -G staff leaver')
      await sh('userdel leaver')
      expect(await group('staff')).not.toContain('leaver')
    }, 60000)

    it('refuses root and an unknown user', async () => {
      expect((await sh('userdel root')).err).toContain('cannot remove the root user')
      expect((await sh('userdel nobody-here')).err).toContain('does not exist')
      expect((await sh('userdel')).code).toBe(2)
    }, 30000)

    it('groupdel will not remove the primary group of a user that exists', async () => {
      const refused = await sh('groupdel carol')
      expect(refused.code).toBe(1)
      expect(refused.err).toContain("cannot remove the primary group of user 'carol'")
    }, 30000)
  })

  describe('passwords and the registry', () => {
    it('an administrator reset persists to /etc/shadow, and the old password stops working', async () => {
      await sh('useradd -p secret1 resetme')
      const user = kernel.users.byName('resetme')!
      const before = await fs().readFile('/etc/shadow', 'utf-8')
      await kernel.users.resetPassword(user.uid, 'brandnew1')
      expect(await fs().readFile('/etc/shadow', 'utf-8')).not.toBe(before)
      await expect(kernel.users.login('resetme', 'brandnew1')).resolves.toBeDefined()
      await expect(kernel.users.login('resetme', 'secret1')).rejects.toThrow()
      await expect(kernel.users.resetPassword(user.uid, 'abc')).rejects.toThrow(/at least 4/)
    }, 30000)

    it('group names survive a rewrite of /etc/group, and are read back at boot', async () => {
      await sh('groupadd persistent')
      await sh('useradd -p secret1 -G persistent keeper')
      expect(await group('persistent')).toContain('keeper')
      // the file is what a reload reads: names and members come back from it
      const text = await fs().readFile('/etc/group', 'utf-8')
      expect(text).toMatch(/^persistent:x:\d+:keeper$/m)
      await kernel.users.load().catch(() => {})
      expect(kernel.users.findGroup('persistent')).toBeDefined()
      expect(kernel.users.byName('keeper')?.groups).toContain(kernel.users.findGroup('persistent')!.gid)
    }, 30000)
  })

  describe('visudo', () => {
    const sudoers = '/etc/sudoers'
    const editor = (name: string, body: string) => fs().writeFile(`/tmp/${name}.js`, `const s = globalThis.ecmaosSyscalls\n${body}`, { mode: 0o755 })

    it('checks a file without editing it', async () => {
      const good = await sh('visudo -c')
      expect(good.code).toBe(0)
      expect(good.out).toContain('parsed OK')
      await fs().writeFile('/tmp/bad-sudoers', 'this is not a rule\n')
      const bad = await sh('visudo -c -f /tmp/bad-sudoers')
      expect(bad.code).toBe(1)
      expect(bad.err).toContain('syntax error near line 1')
      expect((await sh('visudo -cq')).out).toBe('')
    }, 30000)

    it('notes what is valid sudoers but not supported here, and -s makes it an error', async () => {
      await fs().writeFile('/tmp/alias-sudoers', 'User_Alias ADMINS = alice\nroot ALL=(ALL) ALL\n')
      const lenient = await sh('visudo -c -f /tmp/alias-sudoers')
      expect(lenient.code).toBe(0)
      expect(lenient.err).toContain('User_Alias is not supported')
      expect((await sh('visudo -cs -f /tmp/alias-sudoers')).code).toBe(1)
    }, 30000)

    it('installs what the editor leaves when it is sound, mode 0440', async () => {
      await editor('sudo-editor-good', "const fd = s.open(s.argv[1], s.O_WRONLY | s.O_CREAT | s.O_TRUNC, 0o440)\ns.writeAll(fd, new TextEncoder().encode('root ALL=(ALL) ALL\\nzed ALL=(root) NOPASSWD: /bin/ls\\n'))\ns.close(fd)")
      const result = await sh('EDITOR=/tmp/sudo-editor-good.js visudo')
      expect(result.code).toBe(0)
      expect(await fs().readFile(sudoers, 'utf-8')).toContain('zed ALL=(root) NOPASSWD: /bin/ls')
      expect((await fs().stat(sudoers)).mode & 0o777).toBe(0o440)
      expect(await fs().exists(`${sudoers}.tmp`)).toBe(false)
    }, 30000)

    it('will not install a broken file, and leaves the old one', async () => {
      const before = await fs().readFile(sudoers, 'utf-8')
      await editor('sudo-editor-bad', "const fd = s.open(s.argv[1], s.O_WRONLY | s.O_CREAT | s.O_TRUNC, 0o440)\ns.writeAll(fd, new TextEncoder().encode('garbage\\n'))\ns.close(fd)")
      const result = await sh("echo x | EDITOR=/tmp/sudo-editor-bad.js visudo")
      expect(result.code).toBe(1)
      expect(result.out).toContain('What now?')
      expect(result.err).toContain('syntax')
      expect(await fs().readFile(sudoers, 'utf-8')).toBe(before)
      expect(await fs().exists(`${sudoers}.tmp`)).toBe(false)
    }, 30000)

    it('saves it anyway when told Q', async () => {
      const before = await fs().readFile(sudoers, 'utf-8')
      const result = await sh("echo Q | EDITOR=/tmp/sudo-editor-bad.js visudo")
      expect(result.code).toBe(0)
      expect(await fs().readFile(sudoers, 'utf-8')).toBe('garbage\n')
      await fs().writeFile(sudoers, before, { mode: 0o440 })
    }, 30000)

    it('says when nothing changed, and when the editor is missing or the file is busy', async () => {
      await editor('sudo-editor-noop', 's.exit(0)')
      const unchanged = await sh('EDITOR=/tmp/sudo-editor-noop.js visudo')
      expect(unchanged.code).toBe(0)
      expect(unchanged.err).toContain('unchanged')
      expect((await sh('EDITOR=no-such-editor visudo')).err).toContain('command not found')
      await fs().writeFile(`${sudoers}.tmp`, 'x')
      expect((await sh('EDITOR=/tmp/sudo-editor-noop.js visudo')).err).toContain('busy')
      await fs().unlink(`${sudoers}.tmp`)
      expect((await sh('visudo --bogus')).code).toBe(1)
    }, 30000)
  })

  describe('who may run them', () => {
    it('only root', async () => {
      if (!await canRunProgramsAsUser(fs())) return
      await sh('useradd -p secret1 plain')
      const user = kernel.users.byName('plain')!
      const root = { ...kernel.shell.credentials }
      const rootContext = kernel.shell.context
      const credentials = { uid: user.uid, gid: user.gid, suid: user.uid, sgid: user.gid, euid: user.uid, egid: user.gid, groups: [user.gid] }
      kernel.shell.credentials = credentials
      kernel.shell.context = bindContext({ root: '/', pwd: '/', credentials })
      try {
        for (const command of ['useradd -p secret1 sneaky', 'groupadd sneaky', 'userdel plain', 'usermod -s /x plain', 'visudo -c', 'passwd -l plain', 'passwd -S plain', 'chage -M 1 plain', 'chage -l plain']) {
          const result = await sh(command)
          expect(result.code, command).not.toBe(0)
        }
      } finally {
        kernel.shell.credentials = root
        kernel.shell.context = rootContext
      }
      expect((await sh('getent passwd sneaky')).code).toBe(2)
      expect((await sh('getent group sneaky')).code).toBe(2)
    }, 60000)
  })
})
