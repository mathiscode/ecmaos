import { describe, expect, it } from 'vitest'

import { DEFAULT_SUDOERS, checkSudo, listPrivileges, parseSudoers, readSudoers } from '../../src/lib/sudoers.ts'

const alice = { user: 'alice', uid: 1000, groups: ['alice', 'sudo'], gids: [1000, 27], host: 'ecmaos' }
const bob = { user: 'bob', uid: 1001, groups: ['bob'], gids: [1001], host: 'ecmaos' }
const ask = (who: typeof alice, command: string, args: string[] = [], runAs = 'root') => ({ ...who, runAs, command, args })

describe('parseSudoers', () => {
  it('reads rules, ignoring comments and blank lines', () => {
    const policy = parseSudoers('# a comment\n\nroot ALL=(ALL:ALL) ALL # trailing\n')
    expect(policy.warnings).toEqual([])
    expect(policy.rules).toHaveLength(1)
    expect(policy.rules[0]?.users).toEqual(['root'])
    expect(policy.rules[0]?.commands[0]).toMatchObject({ command: 'ALL', runAs: ['ALL'], negated: false, noPassword: false })
  })

  it('reads Defaults, and warns about the ones it does not know', () => {
    const policy = parseSudoers('Defaults timestamp_timeout=0\nDefaults !authenticate\nDefaults env_reset\n')
    expect(policy.defaults).toEqual({ timestampTimeout: 0, authenticate: false })
    expect(policy.warnings).toEqual(['line 3: Defaults env_reset is not supported'])
  })

  it('skips a line that does not parse, with a warning, and keeps the rest', () => {
    const policy = parseSudoers('nonsense\nalice ALL=(root) ls\nroot ALL=(ALL) ALL\n')
    expect(policy.rules).toHaveLength(1)
    expect(policy.warnings).toHaveLength(2)
    expect(policy.warnings[1]).toContain("'ls' is not an absolute path")
  })

  it('warns about includes when reading one text alone', () => {
    const policy = parseSudoers('#includedir /etc/sudoers.d\n#include /etc/more\n')
    expect(policy.rules).toEqual([])
    expect(policy.warnings).toEqual(['line 1: #includedir is not supported', 'line 2: #include is not supported'])
  })

  describe('readSudoers', () => {
    const files: Record<string, { text: string, uid?: number, mode?: number }> = {}
    const dirs: Record<string, string[]> = {}
    const io = {
      readFile: (path: string) => files[path]?.text,
      readdir: (path: string) => dirs[path],
      stat: (path: string) => files[path] ? { uid: files[path]!.uid ?? 0, mode: files[path]!.mode ?? 0o100440 } : undefined
    }
    const request = (user: string, command: string) => ({ user, uid: 1000, groups: [], gids: [], host: 'h', runAs: 'root', command, args: [] })

    it('follows #include and @includedir, in order, skipping backups and names with a dot', () => {
      files['/etc/sudoers'] = { text: 'root ALL=(ALL) ALL\n@includedir /etc/sudoers.d\n#include more\n' }
      files['/etc/more'] = { text: 'carol ALL=(root) /bin/df\n' }
      dirs['/etc/sudoers.d'] = ['20-web', '10-alice', 'old.dpkg-old', 'web~', '30-bad']
      files['/etc/sudoers.d/10-alice'] = { text: 'Cmnd_Alias LS = /bin/ls\n' }
      files['/etc/sudoers.d/20-web'] = { text: 'alice ALL=(root) NOPASSWD: LS\n' }
      files['/etc/sudoers.d/old.dpkg-old'] = { text: 'alice ALL=(root) ALL\n' }
      files['/etc/sudoers.d/web~'] = { text: 'alice ALL=(root) ALL\n' }
      files['/etc/sudoers.d/30-bad'] = { text: 'alice ALL=(root) rm\n' }
      const policy = readSudoers('/etc/sudoers', io)!
      expect(policy.files).toEqual(['/etc/sudoers', '/etc/sudoers.d/10-alice', '/etc/sudoers.d/20-web', '/etc/sudoers.d/30-bad', '/etc/more'])
      // an alias from one file is used in the next
      expect(checkSudo(policy, request('alice', '/bin/ls')).allowed).toBe(true)
      expect(checkSudo(policy, request('alice', '/bin/rm')).allowed).toBe(false)
      expect(checkSudo(policy, request('carol', '/bin/df')).allowed).toBe(true)
      expect(policy.warnings).toEqual(["/etc/sudoers.d/30-bad: line 1: 'rm' is not an absolute path"])
    })

    it('leaves out a file root does not own or others may write, and says why', () => {
      files['/etc/sudoers'] = { text: '#include /etc/a\n#include /etc/b\n#include /etc/none\n' }
      files['/etc/a'] = { text: 'alice ALL=(root) ALL\n', uid: 1000 }
      files['/etc/b'] = { text: 'alice ALL=(root) ALL\n', mode: 0o100666 }
      const policy = readSudoers('/etc/sudoers', io)!
      expect(policy.rules).toEqual([])
      expect(policy.warnings).toEqual([
        '/etc/sudoers: line 1: /etc/a is owned by uid 1000, should be 0',
        '/etc/sudoers: line 2: /etc/b is world writable',
        '/etc/sudoers: line 3: unable to open /etc/none'
      ])
    })

    it('stops a file that includes itself', () => {
      files['/etc/sudoers'] = { text: '#include /etc/sudoers\n' }
      expect(readSudoers('/etc/sudoers', io)!.warnings).toEqual(['/etc/sudoers: line 1: too many levels of includes'])
      expect(readSudoers('/etc/missing', io)).toBeUndefined()
    })
  })

  it('joins a line continued with a backslash', () => {
    const policy = parseSudoers('alice ALL=(root) /bin/ls, \\\n /bin/cat\n')
    expect(policy.rules[0]?.commands.map(c => c.command)).toEqual(['/bin/ls', '/bin/cat'])
  })

  it('carries runas and tags forward through a command list', () => {
    const policy = parseSudoers('alice ALL=(root) NOPASSWD: /bin/ls, (bob) PASSWD: /bin/cat')
    const [ls, cat] = policy.rules[0]?.commands ?? []
    expect(ls).toMatchObject({ runAs: ['root'], noPassword: true })
    expect(cat).toMatchObject({ runAs: ['bob'], noPassword: false })
  })
})

describe('checkSudo', () => {
  it('allows the default file for root and the sudo group, and nobody else', () => {
    const policy = parseSudoers(DEFAULT_SUDOERS)
    expect(checkSudo(policy, ask({ ...alice, user: 'root', uid: 0, groups: ['root'], gids: [0] }, '/bin/ls')).allowed).toBe(true)
    expect(checkSudo(policy, ask(alice, '/bin/ls')).allowed).toBe(true)
    expect(checkSudo(policy, ask(bob, '/bin/ls')).allowed).toBe(false)
  })

  it('asks for a password unless the rule says NOPASSWD', () => {
    const policy = parseSudoers('alice ALL=(root) NOPASSWD: /bin/ls, /bin/cat')
    expect(checkSudo(policy, ask(alice, '/bin/ls'))).toEqual({ allowed: true, noPassword: true })
    expect(checkSudo(parseSudoers('alice ALL=(root) /bin/ls'), ask(alice, '/bin/ls'))).toEqual({ allowed: true, noPassword: false })
  })

  it('turns every password off with Defaults !authenticate', () => {
    const policy = parseSudoers('Defaults !authenticate\nalice ALL=(root) ALL')
    expect(checkSudo(policy, ask(alice, '/bin/ls'))).toEqual({ allowed: true, noPassword: true })
  })

  it('lets the last matching rule decide, so ! forbids one command', () => {
    const policy = parseSudoers('alice ALL=(root) ALL, !/bin/rm')
    expect(checkSudo(policy, ask(alice, '/bin/ls')).allowed).toBe(true)
    expect(checkSudo(policy, ask(alice, '/bin/rm')).allowed).toBe(false)
    expect(checkSudo(parseSudoers('alice ALL=(root) !/bin/rm, ALL'), ask(alice, '/bin/rm')).allowed).toBe(true)
  })

  it('matches only the user it runs as', () => {
    const policy = parseSudoers('alice ALL=(bob) ALL')
    expect(checkSudo(policy, ask(alice, '/bin/ls', [], 'bob')).allowed).toBe(true)
    expect(checkSudo(policy, ask(alice, '/bin/ls', [], 'root')).allowed).toBe(false)
  })

  it('matches users by name, group, gid and uid, and hosts by name', () => {
    expect(checkSudo(parseSudoers('%sudo ALL=(root) ALL'), ask(alice, '/bin/ls')).allowed).toBe(true)
    expect(checkSudo(parseSudoers('%#27 ALL=(root) ALL'), ask(alice, '/bin/ls')).allowed).toBe(true)
    expect(checkSudo(parseSudoers('#1000 ALL=(root) ALL'), ask(alice, '/bin/ls')).allowed).toBe(true)
    expect(checkSudo(parseSudoers('bob, alice ALL=(root) ALL'), ask(alice, '/bin/ls')).allowed).toBe(true)
    expect(checkSudo(parseSudoers('alice otherhost=(root) ALL'), ask(alice, '/bin/ls')).allowed).toBe(false)
    expect(checkSudo(parseSudoers('alice ECMAOS=(root) ALL'), ask(alice, '/bin/ls')).allowed).toBe(true)
  })

  it('requires the exact arguments a rule names, and any when it names none', () => {
    const policy = parseSudoers('alice ALL=(root) /bin/cat /etc/hosts')
    expect(checkSudo(policy, ask(alice, '/bin/cat', ['/etc/hosts'])).allowed).toBe(true)
    expect(checkSudo(policy, ask(alice, '/bin/cat', ['/etc/shadow'])).allowed).toBe(false)
    expect(checkSudo(policy, ask(alice, '/bin/cat', [])).allowed).toBe(false)
    expect(checkSudo(parseSudoers('alice ALL=(root) /bin/cat'), ask(alice, '/bin/cat', ['/etc/shadow'])).allowed).toBe(true)
    expect(checkSudo(parseSudoers('alice ALL=(root) /bin/ls ""'), ask(alice, '/bin/ls', ['-l'])).allowed).toBe(false)
  })

  it('treats a trailing slash as every file in that directory and * as a wildcard', () => {
    const policy = parseSudoers('alice ALL=(root) /usr/bin/, /bin/c*')
    expect(checkSudo(policy, ask(alice, '/usr/bin/env')).allowed).toBe(true)
    expect(checkSudo(policy, ask(alice, '/usr/bin/sub/env')).allowed).toBe(false)
    expect(checkSudo(policy, ask(alice, '/bin/cat')).allowed).toBe(true)
    expect(checkSudo(policy, ask(alice, '/bin/ls')).allowed).toBe(false)
  })
})

describe('listPrivileges', () => {
  it('lists what a user\'s rules grant, in sudo -l form', () => {
    const policy = parseSudoers('alice ALL=(root) NOPASSWD: /bin/ls, !/bin/rm\nbob ALL=(root) ALL')
    expect(listPrivileges(policy, alice)).toEqual(['    (root) NOPASSWD: /bin/ls', '    (root) NOPASSWD: !/bin/rm'])
    expect(listPrivileges(policy, bob)).toEqual(['    (root) ALL'])
  })
})

describe('aliases', () => {
  const text = [
    'Cmnd_Alias READ = /bin/ls, /bin/cat /etc/hosts',
    'Cmnd_Alias DANGER = /bin/rm, /bin/dd',
    'Cmnd_Alias ALLOWED = READ, DANGER',
    'User_Alias ADMINS = alice, %ops : GUESTS = bob',
    'Runas_Alias OPERATORS = root, carol',
    'Host_Alias SERVERS = ecmaos, build',
    'ADMINS SERVERS = (OPERATORS) NOPASSWD: ALLOWED, !DANGER',
    'GUESTS ALL = READ'
  ].join('\n')
  const policy = parseSudoers(text)

  it('parses every kind, several definitions on a line, and nesting, with no warnings', () => {
    expect(policy.warnings).toEqual([])
    expect(policy.rules[0]?.users).toEqual(['alice', '%ops'])
    expect(policy.rules[0]?.hosts).toEqual(['ecmaos', 'build'])
    expect(policy.rules[1]?.users).toEqual(['bob'])
  })

  it('applies the expanded users, hosts, run-as users and commands', () => {
    expect(checkSudo(policy, ask(alice, '/bin/ls', [], 'carol'))).toEqual({ allowed: true, noPassword: true })
    expect(checkSudo(policy, ask(alice, '/bin/cat', ['/etc/hosts']))).toEqual({ allowed: true, noPassword: true })
    expect(checkSudo(policy, ask(alice, '/bin/ls', [], 'bob')).allowed).toBe(false)
    expect(checkSudo(policy, { ...ask(alice, '/bin/ls'), host: 'elsewhere' }).allowed).toBe(false)
  })

  it('forbids every command of an alias behind a !', () => {
    expect(checkSudo(policy, ask(alice, '/bin/rm')).allowed).toBe(false)
    expect(checkSudo(policy, ask(alice, '/bin/dd')).allowed).toBe(false)
    expect(checkSudo(policy, ask(bob, '/bin/ls')).allowed).toBe(true)
    expect(checkSudo(policy, ask(bob, '/bin/rm')).allowed).toBe(false)
  })

  it('lets a rule use an alias defined after it', () => {
    const later = parseSudoers('ADMINS ALL = (root) ALL\nUser_Alias ADMINS = alice\n')
    expect(later.warnings).toEqual([])
    expect(checkSudo(later, ask(alice, '/bin/ls')).allowed).toBe(true)
    expect(checkSudo(later, ask(bob, '/bin/ls')).allowed).toBe(false)
  })

  it('skips a rule with an alias loop, and a malformed definition, with a warning', () => {
    const bad = parseSudoers('Cmnd_Alias A = B\nCmnd_Alias B = A\nalice ALL = A\nUser_Alias BROKEN\nroot ALL = ALL\n')
    expect(bad.rules).toHaveLength(1)
    expect(bad.warnings).toEqual(['line 4: expected "User_Alias NAME = members"', 'line 3: aliases are nested too deeply (a loop?)'])
  })

  it('treats an upper-case name that is no alias as a user name', () => {
    const plain = parseSudoers('DEPLOY ALL = /bin/ls\n')
    expect(plain.rules[0]?.users).toEqual(['DEPLOY'])
  })
})
