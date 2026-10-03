import { describe, expect, it } from 'vitest'

import { DEFAULT_SUDOERS, checkSudo, listPrivileges, parseSudoers } from '../../src/lib/sudoers.ts'

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

  it('warns about aliases and includes instead of guessing', () => {
    const policy = parseSudoers('User_Alias ADMINS = alice\n#includedir /etc/sudoers.d\n')
    expect(policy.rules).toEqual([])
    expect(policy.warnings).toEqual(['line 1: User_Alias is not supported', 'line 2: #includedir is not supported'])
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
