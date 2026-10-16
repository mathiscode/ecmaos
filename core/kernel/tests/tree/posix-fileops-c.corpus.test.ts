import { beforeAll, describe, expect, it } from 'vitest'

import { usePosixKernel } from './fixtures/posix-fileops'

/** POSIX file operations against what GNU coreutils do (test, split, mktemp and sleep); the expected values were taken from GNU coreutils 9. */
describe('POSIX file operations', { timeout: 120000 }, () => {
  const posix = usePosixKernel()
  const { run, runIn, fs } = posix

  describe('test and [', () => {
    const files = 'echo aa > a; echo b > b; touch -d "2020-01-01" old; touch -d "2024-01-01" new; chmod 755 x 2>/dev/null; : > e; mkdir d; ln -s a l; ln -s gone dang; ln a hard; chmod 4755 a; chmod 1755 d'
    // the tree is only read by these cases, so it is built once rather than for each expression
    let tree = ''
    beforeAll(async () => { tree = (await run(files, 'true')).dir })
    const status = async (setup: string, expression: string, shell = 'test') =>
      (await (setup === files ? runIn(tree, `${shell} ${expression}; echo $?`) : run(setup, `${shell} ${expression}; echo $?`))).out.trim()
    it('reads the type and mode of files', async () => {
      expect(await status(files, '-e a')).toBe('0')
      expect(await status(files, '-f a')).toBe('0')
      expect(await status(files, '-d d')).toBe('0')
      expect(await status(files, '-d a')).toBe('1')
      expect(await status(files, '-s a')).toBe('0')
      expect(await status(files, '-s e')).toBe('1')
      expect(await status(files, '-L l')).toBe('0')
      expect(await status(files, '-h dang')).toBe('0')
      expect(await status(files, '-e dang')).toBe('1')
      expect(await status(files, '-u a')).toBe('0')
      expect(await status(files, '-g a')).toBe('1')
      expect(await status(files, '-k d')).toBe('0')
      expect(await status(files, '-c /dev/null')).toBe('0')
      expect(await status(files, '-b /dev/null')).toBe('1')
      expect(await status(files, '-p /dev/null')).toBe('1')
      expect(await status(files, '-S /dev/null')).toBe('1')
    })
    it('judges access for the effective user', async () => {
      expect(await status('echo > f; chmod 000 f', '-x f')).toBe('1')
      expect(await status('echo > f; chmod 755 f', '-x f')).toBe('0')
      expect(await status('mkdir d; chmod 000 d', '-x d')).toBe('0')
      expect(await status('echo > f', '-O f')).toBe('0')
      expect(await status('echo > f', '-G f')).toBe('0')
    })
    it('compares files', async () => {
      expect(await status(files, 'new -nt old')).toBe('0')
      expect(await status(files, 'old -nt new')).toBe('1')
      expect(await status(files, 'old -ot new')).toBe('0')
      expect(await status(files, 'new -nt missing')).toBe('0')
      expect(await status(files, 'missing -ot new')).toBe('0')
      expect(await status(files, 'a -ef hard')).toBe('0')
      expect(await status(files, 'a -ef l')).toBe('0')
      expect(await status(files, 'a -ef b')).toBe('1')
    })
    it('compares strings and integers', async () => {
      expect(await status('', "a '<' b")).toBe('0')
      expect(await status('', "b '>' a")).toBe('0')
      expect(await status('', "B '<' a")).toBe('0')
      expect(await status('', '10 -gt 9')).toBe('0')
      expect(await status('', '" 7 " -eq 7')).toBe('0')
      expect(await status('', '-1 -lt 0')).toBe('0')
    })
    it('counts the arguments before reading operators', async () => {
      expect(await status('', '')).toBe('1')
      expect(await status('', '-f')).toBe('0')
      expect(await status('', '-n')).toBe('0')
      expect(await status('', '!')).toBe('0')
      expect(await status('', '! x')).toBe('1')
      expect(await status('', '! ""')).toBe('0')
      expect(await status('', '! -n x')).toBe('1')
      expect(await status('', "'(' x ')'")).toBe('0')
      expect(await status('', "'(' -n x ')'")).toBe('0')
      expect(await status('', "x -a ''")).toBe('1')
      expect(await status('', "x -o ''")).toBe('0')
      expect(await status('', '! x = y')).toBe('0')
      expect(await status('', '= = =')).toBe('0')
    })
    it('parses longer expressions with -a binding tighter than -o', async () => {
      expect(await status('', '-n a -a -n b -o -z c')).toBe('0')
      expect(await status('', "-n a -o -z b -a -z c")).toBe('0')
      expect(await status('', "'(' -z a -o -n b ')' -a -n c")).toBe('0')
      expect(await status('', "! -z a -a ! -z b")).toBe('0')
    })
    it('[ needs its closing bracket and reports bad expressions', async () => {
      expect((await run('', '[ -n x')).err).toBe("ecmaos: [: missing `]'\n")
      expect((await run('', '[ -n x')).code).toBe(2)
      expect((await run('', 'test abc -eq 1')).err).toBe('ecmaos: test: abc: integer expression expected\n')
      expect((await run('', 'test abc -eq 1')).code).toBe(2)
      expect((await run('', 'test a b')).err).toBe('ecmaos: test: unary operator expected\n')
      expect((await run('', 'test a b c')).err).toBe('ecmaos: test: binary operator expected\n')
      expect((await run('', "test '(' a")).code).toBe(2)
    })
    it('-o and -v read the shell', async () => {
      expect(await status('', '-o noglob')).toBe('1')
      expect((await run('', '{ set -o noglob; test -o noglob; echo $?; set +o noglob; }')).out).toBe('0\n')
      expect(await status('', '-o bogus')).toBe('1')
      expect(await status('x=1', '-v x')).toBe('0')
      expect(await status('', '-v nope')).toBe('1')
      expect(await status('a=(p q)', '-v a[1]')).toBe('0')
      expect(await status('a=(p q)', '-v a[5]')).toBe('1')
    })
  })
  describe('split', () => {
    const lines = 'printf "1\\n2\\n3\\n4\\n5\\n" > in'
    const listing = async (setup: string, command: string) => (await run(setup, `${command}; ls | tr '\\n' ' '`)).out
    it('splits by lines into the current directory, not the input directory', async () => {
      expect(await listing(`${lines}; mkdir sub; cp in sub/in`, 'split -l 2 sub/in')).toBe('in sub xaa xab xac ')
      expect((await run(lines, 'split -l 2 in; cat xaa xab xac')).out).toBe('1\n2\n3\n4\n5\n')
    })
    it('names pieces with a prefix, numeric or hex suffixes, a length and an additional suffix', async () => {
      expect(await listing(lines, 'split -l 2 in pre')).toBe('in preaa preab preac ')
      expect(await listing(lines, 'split -d -l 2 in p')).toBe('in p00 p01 p02 ')
      expect(await listing(lines, 'split -x -l 2 in')).toBe('in x00 x01 x02 ')
      expect(await listing(lines, 'split -a 1 -l 2 in')).toBe('in xa xb xc ')
      expect(await listing(lines, 'split --additional-suffix=.t -l 2 in')).toBe('in xaa.t xab.t xac.t ')
      expect(await listing(lines, 'split --numeric-suffixes=5 -l 2 in')).toBe('in x05 x06 x07 ')
      expect(await listing(lines, 'split -l2 in')).toBe('in xaa xab xac ')
      expect(await listing(lines, 'split -2 in')).toBe('in xaa xab xac ')
    })
    it('splits by bytes, with units', async () => {
      expect((await run('head -c 2500 /dev/zero > in', '{ split -b 1K in; wc -c < xaa; wc -c < xab; wc -c < xac; }')).out).toBe('1024\n1024\n452\n')
      expect(await listing('head -c 10 /dev/zero > in', 'split -b 4 in')).toBe('in xaa xab xac ')
    })
    it('-C keeps lines whole', async () => {
      const r = await run('printf "aaa\\nbb\\nc\\n" > in', '{ split -C 5 in; cat xaa; echo --; cat xab; }')
      expect(r.out).toBe('aaa\n--\nbb\nc\n')
    })
    it('-n makes a number of chunks, by bytes or by lines', async () => {
      expect((await run('printf "abcdefghij" > in', '{ split -n 3 in; cat xaa; echo; cat xab; echo; cat xac; }')).out).toBe('abcd\nefg\nhij')
      expect((await run(lines, '{ split -n l/2 in; cat xaa; echo --; cat xab; }')).out).toBe('1\n2\n3\n--\n4\n5\n')
      expect((await run(lines, 'split -n 2/3 in')).out).toBe('3\n4')
      expect((await run(lines, '{ split -n r/2 in; cat xaa; echo --; cat xab; }')).out).toBe('1\n3\n5\n--\n2\n4\n')
      expect((await run(lines, 'split -n r/2/2 in')).out).toBe('2\n4\n')
      expect(await listing(': > in', 'split -n 2 in')).toBe('in xaa xab ')
      expect(await listing(': > in', 'split -e -n 2 in')).toBe('in ')
    })
    it('reads standard input and names created files with --verbose', async () => {
      expect(await listing(lines, 'split -l 2 - < in')).toBe('in xaa xab xac ')
      expect((await run(lines, 'split --verbose -l 2 in')).out).toBe("creating file 'xaa'\ncreating file 'xab'\ncreating file 'xac'\n")
    })
    it('creates no file for empty input and keeps a last line without a newline', async () => {
      expect(await listing(': > in', 'split -l 1 in')).toBe('in ')
      expect((await run('printf "a\\nb" > in', 'split -l 1 in; cat xab')).out).toBe('b')
    })
    it('reports bad arguments in GNU words', async () => {
      expect((await run(lines, 'split -l x in')).err).toBe('split: invalid number of lines: ‘x’\n')
      expect((await run(lines, 'split -b 0 in')).err).toBe('split: invalid number of bytes: ‘0’\n')
      expect((await run(lines, 'split -a x in')).err).toBe('split: invalid suffix length: ‘x’\n')
      expect((await run(lines, 'split -n 0 in')).err).toBe('split: invalid number of chunks: ‘0’\n')
      expect((await run('', 'split nope')).err).toBe('split: cannot open ‘nope’ for reading: No such file or directory\n')
      expect((await run(lines, 'split in a b')).err).toBe("split: extra operand ‘b’\nTry 'split --help' for more information.\n")
      expect((await run('seq 30 > in', 'split -a 1 -l 1 in')).err).toBe('split: output file suffixes exhausted\n')
    })
  })
  describe('mktemp', () => {
    it('makes a file from a template in the current directory, mode 0600', async () => {
      const r = await run('', 'mktemp fooXXXXXX')
      expect(r.out).toMatch(/^foo[A-Za-z0-9]{6}\n$/)
      const name = r.out.trim()
      expect(await r.exists(name)).toBe(true)
      expect((await run('', 'mktemp fooXXXXXX; stat -c %a foo*')).out.split('\n')[1]).toMatch(/^[0-7]*$/)
    })
    it('keeps what follows the X run, or --suffix', async () => {
      expect((await run('', 'mktemp x.XXXXXX.y')).out).toMatch(/^x\.[A-Za-z0-9]{6}\.y\n$/)
      expect((await run('', 'mktemp --suffix=.s fooXXXX')).out).toMatch(/^foo[A-Za-z0-9]{4}\.s\n$/)
    })
    it('-d makes a directory, -u only names one', async () => {
      const d = await run('', 'mktemp -d dXXXXXX')
      expect(await d.exists(d.out.trim())).toBe(true)
      const u = await run('', 'mktemp -u uXXXXXX')
      expect(await u.exists(u.out.trim())).toBe(false)
    })
    it('-p puts the template in a directory, the default goes in /tmp', async () => {
      const p = await run('mkdir sub', 'mktemp -p sub XXXXXX')
      expect(p.out).toMatch(/^sub\/[A-Za-z0-9]{6}\n$/)
      const d = await run('', 'mktemp')
      expect(d.out).toMatch(/^\/tmp\/tmp\.[A-Za-z0-9]{10}\n$/)
      await fs().unlink(d.out.trim())
      const t = await run('', 'TMPDIR=/tmp mktemp -t zXXXXXX')
      expect(t.out).toMatch(/^\/tmp\/z[A-Za-z0-9]{6}\n$/)
      await fs().unlink(t.out.trim())
    })
    it('reports a missing directory and a bad template', async () => {
      const m = await run('', 'mktemp nonexist/XXXXXX')
      expect(m.code).toBe(1)
      expect(m.err).toBe("mktemp: failed to create file via template ‘nonexist/XXXXXX’: No such file or directory\n")
      expect((await run('', 'mktemp -q nonexist/XXXXXX')).err).toBe('')
      expect((await run('', 'mktemp XX')).err).toBe("mktemp: too few X's in template ‘XX’\n")
      expect((await run('', 'mktemp -d nonexist/XXXXXX')).err).toBe("mktemp: failed to create directory via template ‘nonexist/XXXXXX’: No such file or directory\n")
    })
  })

  describe('sleep', () => {
    it('accepts decimals, exponents, hex, suffixes and sums', async () => {
      for (const arg of ['0', '0.01', '.01', '1e-3', '0x0', '0.001s', '0m', '0h', '0d', '0 0.01s']) expect((await run('', `sleep ${arg}`)).code).toBe(0)
    })
    it('rejects a bad interval in GNU words', async () => {
      const r = await run('', 'sleep abc')
      expect(r.code).toBe(1)
      expect(r.err).toBe("sleep: invalid time interval ‘abc’\nTry 'sleep --help' for more information.\n")
      expect((await run('', 'sleep 1x')).err).toContain("invalid time interval ‘1x’")
      expect((await run('', 'sleep')).err).toBe("sleep: missing operand\nTry 'sleep --help' for more information.\n")
      expect((await run('', 'sleep -1')).err).toBe("sleep: invalid option -- '1'\nTry 'sleep --help' for more information.\n")
    })
    it('--help goes to standard output', async () => {
      expect((await run('', 'sleep --help')).out).toMatch(/^Usage: sleep NUMBER\[SUFFIX\]\.\.\./)
    })
  })
})
