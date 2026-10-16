import { afterEach, describe, expect, it } from 'vitest'

import { usePosixKernel } from './fixtures/posix-fileops'

/** POSIX file operations against what GNU coreutils do (dd, umask, cd and pwd); the expected values were taken from GNU coreutils 9. */
describe('POSIX file operations', { timeout: 120000 }, () => {
  const posix = usePosixKernel()
  const { run } = posix

  describe('dd', () => {
    const text = 'printf "one two\\nthree four\\n" > in'
    it('copies a file and reports full+partial records and a byte count in GNU form', async () => {
      const r = await run(text, 'dd if=in of=out')
      expect(r.err).toMatch(/^0\+1 records in\n0\+1 records out\n19 bytes copied, \S+ s, \S+ \S+\/s\n$/)
      expect((await run(text, 'dd if=in of=out 2>/dev/null; cat out')).out).toBe('one two\nthree four\n')
    })
    it('counts blocks with bs, count and skip', async () => {
      expect((await run(text, 'dd if=in bs=3 count=2 status=noxfer')).err).toBe('2+0 records in\n2+0 records out\n')
      expect((await run(text, 'dd if=in bs=3 count=2 status=none')).out).toBe('one tw')
      expect((await run(text, 'dd if=in bs=3 skip=1 count=1 status=none')).out).toBe(' tw')
      expect((await run(text, 'dd if=in bs=7 status=noxfer')).err).toBe('2+1 records in\n2+1 records out\n')
    })
    it('reblocks into obs-sized writes, counting output records', async () => {
      expect((await run(text, 'dd if=in ibs=4 obs=8 status=noxfer')).err).toBe('4+1 records in\n2+1 records out\n')
    })
    it('takes size suffixes and products', async () => {
      expect((await run('head -c 3000 /dev/zero > in', 'dd if=in bs=1K status=noxfer')).err).toBe('2+1 records in\n2+1 records out\n')
      expect((await run('head -c 1000 /dev/zero > in', 'dd if=in bs=2x250 status=noxfer')).err).toBe('2+0 records in\n2+0 records out\n')
      expect((await run('head -c 2000 /dev/zero > in', 'dd if=in bs=1kB status=noxfer')).err).toBe('2+0 records in\n2+0 records out\n')
    })
    it('converts case, swaps bytes and pads with sync', async () => {
      expect((await run(text, 'dd if=in conv=ucase status=none')).out).toBe('ONE TWO\nTHREE FOUR\n')
      expect((await run('printf "ABCD" > in', 'dd if=in conv=lcase status=none')).out).toBe('abcd')
      expect((await run('printf "abcd" > in', 'dd if=in conv=swab status=none')).out).toBe('badc')
      expect((await run(text, 'dd if=in conv=sync bs=32 status=none | wc -c')).out.trim()).toBe('32')
    })
    it('blocks and unblocks records of cbs bytes', async () => {
      expect((await run('printf "ab\\ncd\\n" > in', 'dd if=in cbs=4 conv=block status=none')).out).toBe('ab  cd  ')
      expect((await run('printf "ab  cd  " > in', 'dd if=in cbs=4 conv=unblock status=none')).out).toBe('ab\ncd\n')
    })
    it('honours iflag count_bytes and skip_bytes', async () => {
      expect((await run(text, 'dd if=in iflag=count_bytes count=5 status=none')).out).toBe('one t')
      expect((await run(text, 'dd if=in iflag=skip_bytes skip=4 status=none')).out).toBe('two\nthree four\n')
    })
    it('seek positions output, notrunc keeps what was there, append adds to the end', async () => {
      expect((await run('printf "abcdef" > out; printf "XY" > in', 'dd if=in of=out seek=2 bs=1 conv=notrunc status=none; cat out')).out).toBe('abXYef')
      expect((await run('printf "abc" > out; printf "XY" > in', 'dd if=in of=out oflag=append conv=notrunc status=none; cat out')).out).toBe('abcXY')
      expect((await run('printf "abcdef" > out; printf "XY" > in', 'dd if=in of=out bs=1 status=none; cat out')).out).toBe('XY')
    })
    it('reads standard input and writes standard output', async () => {
      expect((await run('', 'printf "hello" | dd status=none')).out).toBe('hello')
    })
    it('reports bad operands and missing files in GNU words', async () => {
      expect((await run(text, 'dd if=in bs=0')).err).toBe("dd: invalid number: '0'\n")
      expect((await run(text, 'dd if=in bs=1y')).err).toBe("dd: invalid number: '1y'\n")
      expect((await run(text, 'dd foo')).err).toBe("dd: unrecognized operand ‘foo’\nTry 'dd --help' for more information.\n")
      expect((await run(text, 'dd conv=bogus')).err).toContain("dd: invalid conversion: ‘bogus’")
      const m = await run('', 'dd if=nope')
      expect(m.code).toBe(1)
      expect(m.err).toBe("dd: failed to open 'nope': No such file or directory\n")
      expect((await run(text, 'dd if=in of=out conv=excl; dd if=in of=out conv=excl')).err).toContain("failed to open 'out': File exists")
    })
    it('--help is on standard output', async () => {
      expect((await run('', 'dd --help')).out).toMatch(/^Usage: dd \[OPERAND\]\.\.\.\n/)
    })
  })
  describe('umask', () => {
    afterEach(async () => { await posix.kernel.shell.execute('umask 022') })
    it('starts at 022: files are created 0644 and directories 0755', async () => {
      expect((await run('', 'touch f; mkdir d; echo x > r; stat -c %a f d r | tr "\\n" " "')).out).toBe('644 755 644 ')
      expect((await run('', 'umask')).out).toBe('0022\n')
      expect((await run('', 'umask -S')).out).toBe('u=rwx,g=rx,o=rx\n')
    })
    it('changes what the shell and its programs create', async () => {
      expect((await run('', 'umask 077; touch f; mkdir d; echo x > r; stat -c %a f d r | tr "\\n" " "')).out).toBe('600 700 600 ')
      expect((await run('', 'umask 027; touch f; mkdir d; stat -c %a f d | tr "\\n" " "')).out).toBe('640 750 ')
      expect((await run('', 'umask 0; touch f; mkdir d; stat -c %a f d | tr "\\n" " "')).out).toBe('666 777 ')
    })
    it('is inherited by what a program starts', async () => {
      expect((await run('', "umask 077; ecmash -c 'touch f; mkdir d'; stat -c %a f d | tr '\\n' ' '")).out).toBe('600 700 ')
      await posix.kernel.shell.execute('umask 022')
      expect((await run('', "ecmash -c 'umask 077; touch f'; touch g; stat -c %a f g | tr '\\n' ' '")).out).toBe('600 644 ')
    })
    it('takes symbolic modes and prints them back', async () => {
      expect((await run('', 'umask u=rwx,g=,o=; umask')).out).toBe('0077\n')
      expect((await run('', 'umask 027; umask -S')).out).toBe('u=rwx,g=rx,o=\n')
      expect((await run('', 'umask 027; umask -p')).out).toBe('umask 0027\n')
    })
    it('chmod without a class and mkdir -m respect it', async () => {
      expect((await run('', 'umask 077; touch f; chmod 644 f; chmod +x f; stat -c %a f')).out).toBe('744\n')
      expect((await run('', 'umask 077; mkdir -m a+rx d; stat -c %a d')).out).toBe('755\n')
    })
    it('copies are created with the mask taken off the source mode', async () => {
      expect((await run('', 'touch f; chmod 777 f; umask 077; cp f g; stat -c %a g')).out).toBe('700\n')
    })
  })
  describe('cd and pwd', () => {
    const tree = 'mkdir -p sub/deep; ln -s sub dlink'
    it('keeps the name as typed by default and resolves links with -P', async () => {
      expect((await run(tree, 'cd dlink; pwd')).out).toMatch(/\/dlink\n$/)
      expect((await run(tree, 'cd dlink; pwd -P')).out).toMatch(/\/sub\n$/)
      expect((await run(tree, 'cd -P dlink; pwd')).out).toMatch(/\/sub\n$/)
      expect((await run(tree, 'cd -L dlink; pwd')).out).toMatch(/\/dlink\n$/)
      expect((await run(tree, 'cd dlink; cd ..; pwd')).out).toMatch(/\/c\d+\n$/)
      expect((await run(tree, 'cd -P dlink/..; pwd')).out).toMatch(/\/c\d+\n$/)
    })
    it('pwd -L and -P, and --help on standard output', async () => {
      expect((await run(tree, 'cd dlink; pwd -L')).out).toMatch(/\/dlink\n$/)
      expect((await run(tree, 'pwd -P')).out).toMatch(/\/c\d+\n$/)
      expect((await run('', 'pwd --help')).out).toMatch(/^Usage: pwd/)
      expect((await run('', 'pwd -x')).err).toBe("pwd: invalid option -- 'x'\nTry 'pwd --help' for more information.\n")
    })
    it('searches CDPATH and says where it went', async () => {
      const r = await run(tree, '{ export CDPATH=sub; cd deep; pwd; unset CDPATH; }')
      expect(r.out).toMatch(/\/sub\/deep\n\/.*\/sub\/deep\n$/)
      expect((await run(tree, '{ export CDPATH=.:sub; cd deep; pwd; unset CDPATH; }')).out).toMatch(/\/sub\/deep\n$/)
    })
    it('returns to the previous directory with cd -', async () => {
      expect((await run(tree, 'cd sub; cd -')).out).toMatch(/\/c\d+\n$/)
    })
    it('reports a null directory, too many arguments, a bad option and a missing directory', async () => {
      const a = await run('', 'cd ""')
      expect(a.code).toBe(1)
      expect(a.err).toBe('ecmaos: cd: null directory\n')
      const b = await run(tree, 'cd sub deep')
      expect(b.code).toBe(2)
      expect(b.err).toBe('ecmaos: cd: too many arguments\n')
      expect((await run('', 'cd -x')).err).toContain('cd: -x: invalid option')
      expect((await run('', 'cd nope')).err).toBe('ecmaos: cd: nope: No such file or directory\n')
      expect((await run('echo x > f', 'cd f')).err).toBe('ecmaos: cd: f: Not a directory\n')
    })
  })
})
