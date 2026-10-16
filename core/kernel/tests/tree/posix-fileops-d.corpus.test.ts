import { describe, expect, it } from 'vitest'

import { usePosixKernel } from './fixtures/posix-fileops'

/** POSIX file operations against what GNU coreutils do (id, env, kill, uname and which); the expected values were taken from GNU coreutils 9. */
describe('POSIX file operations', { timeout: 120000 }, () => {
  const posix = usePosixKernel()
  const { run } = posix

  describe('id', () => {
    it('prints the full report with names', async () => {
      expect((await run('', 'id root')).out).toBe('uid=0(root) gid=0(root) groups=0(root)\n')
      expect((await run('', 'id')).out).toMatch(/^uid=0\(root\) gid=0\(root\) groups=0\(root\)/)
    })
    it('-u, -g and -G print one kind, -n as names, -r the real ids', async () => {
      expect((await run('', 'id -u')).out).toBe('0\n')
      expect((await run('', 'id -un')).out).toBe('root\n')
      expect((await run('', 'id -gn')).out).toBe('root\n')
      expect((await run('', 'id -Gn')).out).toMatch(/^root( \w+)*\n$/)
      expect((await run('', 'id -ur')).out).toBe('0\n')
      expect((await run('', 'id -u root')).out).toBe('0\n')
      expect((await run('', 'id -u 0')).out).toBe('0\n')
    })
    it('-z ends with NUL and -a is accepted', async () => {
      expect((await run('', 'id -zu | od -c | head -1')).out).toContain('\\0')
      expect((await run('', 'id -a')).code).toBe(0)
    })
    it('reports bad combinations and missing users in GNU words', async () => {
      expect((await run('', 'id -n')).err).toBe('id: printing only names or real IDs requires -u, -g, or -G\n')
      expect((await run('', 'id -u -g')).err).toBe('id: cannot print "only" of more than one choice\n')
      expect((await run('', 'id -z')).err).toBe('id: option --zero not permitted in default format\n')
      const r = await run('', 'id -u root nonexist')
      expect(r.out).toBe('0\n')
      expect(r.err).toBe('id: ‘nonexist’: no such user\n')
      expect(r.code).toBe(1)
    })
  })
  describe('env', () => {
    it('prints the environment, empty with -i, with NAME=VALUE added', async () => {
      expect((await run('', 'env -i')).out).toBe('')
      expect((await run('', 'env -i FOO=1 BAR=2')).out).toBe('FOO=1\nBAR=2\n')
      expect((await run('', 'env - FOO=1')).out).toBe('FOO=1\n')
      expect((await run('', 'env -i FOO=a=b')).out).toBe('FOO=a=b\n')
      expect((await run('', 'env -u PATH')).out).not.toContain('PATH=')
    })
    it('passes the modified environment to the command', async () => {
      expect((await run('', 'env -i FOO=1 BAR=2 /usr/bin/env')).out).toBe('FOO=1\nBAR=2\n')
      expect((await run('', 'env FOO=hi printenv FOO')).out).toBe('hi\n')
      expect((await run('', 'env -i PATH=/bin printenv PATH')).out).toBe('/bin\n')
    })
    it('-0 ends lines with NUL and cannot be used with a command', async () => {
      expect((await run('', 'env -0 -i A=1 | od -c | head -1')).out).toContain('\\0')
      const r = await run('', 'env -0 true')
      expect(r.code).toBe(125)
      expect(r.err).toBe("env: cannot specify --null (-0) with command\nTry 'env --help' for more information.\n")
    })
    it('-C changes directory, -S splits a string', async () => {
      expect((await run('mkdir sub', 'env -C sub pwd')).out).toMatch(/\/sub\n$/)
      expect((await run('', "env -S 'echo a  b'")).out).toBe('a b\n')
      expect((await run('', "env -S 'FOO=x printenv FOO'")).out).toBe('x\n')
      expect((await run('', 'env -C nope true')).err).toBe('env: cannot change directory to ‘nope’: No such file or directory\n')
    })
    it('reports a missing command, a bad option and a bad -u', async () => {
      const m = await run('', 'env nonexistcmd')
      expect(m.code).toBe(127)
      expect(m.err).toBe('env: ‘nonexistcmd’: No such file or directory\n')
      const o = await run('', 'env -x')
      expect(o.code).toBe(125)
      expect(o.err).toBe("env: invalid option -- 'x'\nTry 'env --help' for more information.\n")
      expect((await run('', 'env -u a=b')).err).toBe('env: cannot unset ‘a=b’: Invalid argument\n')
    })
    it('-v tells what it does', async () => {
      expect((await run('', 'env -v -i FOO=1 true')).err).toBe('cleaning environ\nsetenv:   FOO=1\nexecuting: true\n   arg[0]= ‘true’\n')
    })
    it('does not run shell builtins or functions', async () => {
      expect((await run('f() { echo fn; }', 'env f')).code).toBe(127)
      expect((await run('', 'env cd /')).code).toBe(127)
    })
  })
  describe('kill', () => {
    it('-l lists the signals in rows of five, with SIG', async () => {
      const out = (await run('', 'kill -l')).out
      expect(out.split('\n')[0]).toBe(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP')
      expect(out).toContain('34) SIGRTMIN')
      expect(out).toContain('64) SIGRTMAX')
      expect((await run('', 'kill -L')).out).toBe(out)
    })
    it('-l translates numbers, names and exit statuses', async () => {
      expect((await run('', 'kill -l 9')).out).toBe('KILL\n')
      expect((await run('', 'kill -l TERM')).out).toBe('15\n')
      expect((await run('', 'kill -l SIGKILL')).out).toBe('9\n')
      expect((await run('', 'kill -l 1 2')).out).toBe('HUP\nINT\n')
      expect((await run('', 'kill -l 130')).out).toBe('INT\n')
      expect((await run('', 'kill -l 143')).out).toBe('TERM\n')
      expect((await run('', 'kill -l 0')).out).toBe('EXIT\n')
      expect((await run('', 'kill -l 64')).out).toBe('RTMAX\n')
      expect((await run('', 'kill -l RTMIN')).out).toBe('34\n')
      const bad = await run('', 'kill -l 65')
      expect(bad.code).toBe(1)
      expect(bad.err).toBe('kill: 65: invalid signal specification\n')
    })
    it('reports a missing process, a bad id and a bad signal', async () => {
      expect((await run('', 'kill 999999')).err).toBe('kill: (999999) - No such process\n')
      expect((await run('', 'kill abc')).err).toBe('kill: abc: arguments must be process or job IDs\n')
      expect((await run('', 'kill -FOO 1')).err).toBe('kill: FOO: invalid signal specification\n')
      expect((await run('', 'kill -s FOO 1')).err).toBe('kill: FOO: invalid signal specification\n')
      const none = await run('', 'kill')
      expect(none.code).toBe(2)
      expect(none.out).toContain('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]')
    })
    it('accepts -s, -n and -SIG spellings for signal 0', async () => {
      const r = await run('', '{ sleep 30 & p=$!; for f in "-0" "-s 0" "-n 0" "-s EXIT"; do kill $f $p && echo ok; done; kill $p; wait; }')
      expect(r.err).toBe('')
      expect(r.out).toBe('ok\nok\nok\nok\n')
    })
  })
  describe('uname', () => {
    it('names the kernel Linux by default and prints the GNU set with -a', async () => {
      expect((await run('', 'uname')).out).toBe('Linux\n')
      expect((await run('', 'uname -s')).out).toBe('Linux\n')
      expect((await run('', 'uname -o')).out).toBe('GNU/Linux\n')
      expect((await run('', 'uname -m')).out).toMatch(/^(x86_64|aarch64|i686|armv7l)\n$/)
      expect((await run('', 'uname -a')).out).toMatch(/^Linux \S+ \S+ #1 .* (x86_64|aarch64|i686|armv7l) GNU\/Linux\n$/)
    })
    it('prints the fields in a fixed order whatever the option order', async () => {
      expect((await run('', 'uname -sn')).out).toMatch(/^Linux \S+\n$/)
      expect((await run('', 'uname -ns')).out).toMatch(/^Linux \S+\n$/)
      expect((await run('', 'uname -p')).out).toBe('unknown\n')
    })
    it('rejects an operand', async () => {
      const r = await run('', 'uname extra')
      expect(r.code).toBe(1)
      expect(r.err).toBe("uname: extra operand ‘extra’\nTry 'uname --help' for more information.\n")
    })
  })

  describe('which', () => {
    it('prints the first match along PATH, or all with -a', async () => {
      expect((await run('', 'which sh')).out).toMatch(/\/sh\n$/)
      expect((await run('', 'which sh ls')).out.split('\n').filter(Boolean)).toHaveLength(2)
      expect((await run('', 'which -a sh')).out.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(1)
    })
    it('checks a name with a slash as it stands, and only executables', async () => {
      expect((await run('echo x > f; echo "#!/bin/sh" > g; chmod +x g', 'which ./g')).out).toMatch(/\/g\n$/)
      expect((await run('echo x > f', 'which ./f')).code).toBe(1)
    })
    it('reports a missing command on standard error with the status 1', async () => {
      const r = await run('', 'which nonexist')
      expect(r.code).toBe(1)
      expect(r.out).toBe('')
      expect(r.err).toMatch(/^which: no nonexist in \(.*\)\n$/)
    })
    it('writes the usage to standard error and 255 with no operand', async () => {
      const r = await run('', 'which')
      expect(r.code).toBe(255)
      expect(r.err).toContain('Usage: which [options] [--] COMMAND [...]')
    })
  })
})
