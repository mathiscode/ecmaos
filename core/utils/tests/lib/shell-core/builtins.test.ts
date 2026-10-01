import { describe, expect, it } from 'vitest'

import { FakeHost } from './fake-host.ts'

const run = async (text: string, setup?: (host: FakeHost) => void) => {
  const host = new FakeHost()
  host.shared = true
  setup?.(host)
  const status = await host.run(text)
  return { host, status, out: host.out.join('|'), err: host.errors.join('|') }
}

describe('shared builtins: variables', () => {
  it('export marks a name for children and unset removes it', async () => {
    const { host } = await run('X=1; export X; export Y=2; unset X')
    expect(host.state.lookup('X')).toBeUndefined()
    expect(host.state.isExported('Y')).toBe(true)
  })

  it('readonly refuses a later assignment, and unset of it reports', async () => {
    const { host, status } = await run('readonly R=1; unset R')
    expect(host.state.lookup('R')).toBe('1')
    expect(status).toBe(1)
  })

  it('declare -a makes an array and declare -x exports', async () => {
    const { host } = await run('declare -a list; declare -x E=5')
    expect(host.state.lookupArray('list')?.size).toBe(0)
    expect(host.state.isExported('E')).toBe(true)
  })

  it('local needs a function', async () => {
    expect((await run('local x=1')).status).toBe(1)
  })
})

describe('shared builtins: set and shift', () => {
  it('sets options by cluster and long name', async () => {
    const { host } = await run('set -eu; set -o pipefail; set +e')
    expect(host.state.options).toMatchObject({ errexit: false, nounset: true, pipefail: true })
  })

  it('set -f and -C are real options', async () => {
    const { host } = await run('set -fC')
    expect(host.state.options).toMatchObject({ noglob: true, noclobber: true })
  })

  it('rejects an unknown option', async () => {
    expect((await run('set -Z')).status).toBe(2)
  })

  it('set -- replaces the positional parameters and shift drops them', async () => {
    const { host, status } = await run('set -- a b c; shift 2')
    expect(host.params).toEqual(['c'])
    expect(status).toBe(0)
    const failed = await run('set -- a; shift 2')
    expect(failed.status).toBe(1)
    expect(failed.err).toContain('shift: 2: shift count out of range')
  })
})

describe('shared builtins: read', () => {
  it('splits a line on IFS into names, the last taking the rest', async () => {
    const { host } = await run('read a b', h => { h.stdin = ['1 2 3'] })
    expect(host.state.lookup('a')).toBe('1')
    expect(host.state.lookup('b')).toBe('2 3')
  })

  it('IFS= keeps the whole line, REPLY is the default name', async () => {
    const { host } = await run('IFS=; read -r', h => { h.stdin = ['  keep  '] })
    expect(host.state.lookup('REPLY')).toBe('  keep  ')
  })

  it('read -a fills an array', async () => {
    const { host } = await run('read -a words', h => { h.stdin = ['x y z'] })
    expect([...host.state.lookupArray('words')!.values()]).toEqual(['x', 'y', 'z'])
  })

  it('reports end of file', async () => {
    expect((await run('read a')).status).toBe(1)
  })
})

describe('shared builtins: control flow', () => {
  it('exit ends with the code, defaulting to the last status', async () => {
    expect((await run('exit 7')).status).toBe(7)
    expect((await run('false; exit')).status).toBe(1)
  })

  it('return leaves a function with its status', async () => {
    const { out } = await run('f() { return 4; }; f; echo $?')
    expect(out).toBe('4')
    expect((await run('f() { return 4; }; f')).status).toBe(4)
  })

  it('break 2 leaves two loops', async () => {
    const { out } = await run('for a in 1 2; do for b in x y; do echo $a$b; break 2; done; done; echo end')
    expect(out).toBe('1x|end')
  })

  it('eval and source run in the calling shell', async () => {
    const { host } = await run('eval "v=1"; source /s', h => { h.files.set('/s', 'w=2') })
    expect(host.state.lookup('v')).toBe('1')
    expect(host.state.lookup('w')).toBe('2')
  })

  it('source reports a missing file', async () => {
    expect((await run('source /nope')).status).toBe(1)
  })
})

describe('shared builtins: cd', () => {
  it('moves, keeps OLDPWD and PWD, and cd - goes back', async () => {
    const { host, out } = await run('cd /a; cd /b; cd -', h => { h.directories.add('/a'); h.directories.add('/b') })
    expect(host.cwd).toBe('/a')
    expect(host.state.lookup('OLDPWD')).toBe('/b')
    expect(out).toBe('/a')
  })

  it('goes to HOME with no argument and reports a missing directory', async () => {
    const { host } = await run('HOME=/h; cd', h => { h.directories.add('/h') })
    expect(host.cwd).toBe('/h')
    expect((await run('cd /nope')).status).toBe(1)
  })
})

describe('shared builtins: test and [', () => {
  const status = async (text: string) => (await run(text, h => { h.files.set('/f', 'abc'); h.directories.add('/d') })).status

  it('compares strings and integers', async () => {
    expect(await status('test a = a')).toBe(0)
    expect(await status('test a != a')).toBe(1)
    expect(await status('[ 3 -lt 10 ]')).toBe(0)
    expect(await status('[ 3 -ge 10 ]')).toBe(1)
  })

  it('tests files', async () => {
    expect(await status('[ -f /f ]')).toBe(0)
    expect(await status('[ -d /f ]')).toBe(1)
    expect(await status('[ -d /d ]')).toBe(0)
    expect(await status('[ -s /f ]')).toBe(0)
    expect(await status('[ -e /nope ]')).toBe(1)
  })

  it('handles !, -a, -o and parentheses', async () => {
    expect(await status('[ ! -e /nope ]')).toBe(0)
    expect(await status('[ -f /f -a -d /d ]')).toBe(0)
    expect(await status('[ -f /nope -o -d /d ]')).toBe(0)
    expect(await status('[ -n x -a ( -z "" ) ]')).toBe(0)
  })

  it('needs the closing bracket and a number where one is expected', async () => {
    expect(await status('[ a = a')).toBe(2)
    expect(await status('[ a -lt 3 ]')).toBe(2)
  })

  it('a lone string is true unless empty', async () => {
    expect(await status('[ x ]')).toBe(0)
    expect(await status('[ "" ]')).toBe(1)
  })
})

describe('shared builtins: getopts, alias, type, command, trap', () => {
  it('getopts walks the options', async () => {
    const { out } = await run('set -- -a -b val rest; while getopts "ab:" o; do echo $o:$OPTARG; done; echo $OPTIND')
    expect(out).toBe('a:|b:val|4')
  })

  it('alias defines and lists, unalias removes', async () => {
    const { out, host } = await run('alias ll="ls -l"; alias ll; unalias ll')
    expect(out).toBe("alias ll='ls -l'")
    expect(host.state.aliases.has('ll')).toBe(false)
  })

  it('type names the kind of each command', async () => {
    const { out } = await run('f() { :; }; type -t f; type -t cd; type -t nothing', h => h.files.set('/bin/x', ''))
    expect(out).toBe('function|builtin')
  })

  it('command skips a function of the same name', async () => {
    const { out } = await run('echo() { :; }; command echo hi')
    expect(out).toBe('hi')
  })

  it('trap records, lists and clears handlers', async () => {
    const { out, host } = await run("trap 'echo bye' EXIT; trap; trap - EXIT")
    expect(out).toBe("trap -- 'echo bye' EXIT")
    expect(host.state.getTrap('EXIT')).toBeUndefined()
  })
})
