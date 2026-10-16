import { describe, expect, it } from 'vitest'

import { usePosixKernel } from './fixtures/posix-fileops'

/** POSIX file operations against what GNU coreutils do (ls, chmod, mkdir and du); the expected values were taken from GNU coreutils 9. */
describe('POSIX file operations', { timeout: 120000 }, () => {
  const posix = usePosixKernel()
  const { run, fs } = posix

  describe('ls', () => {
    const setup = "touch -d '2020-01-02 12:04:05 UTC' a.c; touch -d '2024-03-05 12:11:12 UTC' b.h A; mkdir -p d sub/in; ln -s a.c l; echo a > 'sp ace'"
    const one = async (flags: string, extra = '') => (await run(setup + extra, `ls ${flags}`)).out

    it('sorts names bytewise, like sort', async () => {
      expect(await one('-1')).toBe('A\na.c\nb.h\nd\nl\nsp ace\nsub\n')
    })
    it('-Q, -b and -q quote names', async () => {
      expect(await one('-1Q')).toBe('"A"\n"a.c"\n"b.h"\n"d"\n"l"\n"sp ace"\n"sub"\n')
      expect(await one('-1b')).toContain('sp\\ ace\n')
      await fs().mkdir('/tmp/posix/tabdir', { recursive: true })
      await fs().writeFile('/tmp/posix/tabdir/t\tab', 'x')
      const r = await run('', 'ls -1b /tmp/posix/tabdir')
      expect(r.out).toBe('t\\tab\n')
    })
    it('sorts by extension, version, size, time and none', async () => {
      expect(await one('-1X')).toBe('A\nd\nl\nsp ace\nsub\na.c\nb.h\n')
      expect((await run('touch f1 f10 f2', 'ls -1v')).out).toBe('f1\nf2\nf10\n')
      expect(await one('-1t')).toContain('A\nb.h\na.c\n'.replace('A\n', ''))
      expect((await run('touch -d 2001-01-01 old; touch new', 'ls -1t')).out).toBe('new\nold\n')
      expect((await run('echo aaa > big; echo b > small', 'ls -1S')).out).toBe('big\nsmall\n')
      expect((await run('echo aaa > big; echo b > small', 'ls --sort=size -r -1')).out).toBe('small\nbig\n')
    })
    it('--group-directories-first, -I and -d', async () => {
      expect(await one('--group-directories-first -1')).toBe('d\nsub\nA\na.c\nb.h\nl\nsp ace\n')
      expect(await one("-1 -I '*.c' -I A")).toBe('b.h\nd\nl\nsp ace\nsub\n')
      expect((await run('mkdir d; touch d/x', 'ls -d d')).out).toBe('d\n')
    })
    it('lays names out in columns, across, and as a comma list', async () => {
      const files = 'touch A a.c b.h d l'
      expect((await run(files, 'ls -C -w 20')).out).toBe('A  a.c\tb.h  d\tl\n')
      expect((await run(files, 'ls -x -w 20')).out).toBe('A  a.c\tb.h  d\tl\n')
      expect((await run(files, 'ls -m -w 20')).out).toBe('A, a.c, b.h, d, l\n')
      expect((await run(files, 'ls -m -w 12')).out).toBe('A, a.c, b.h,\nd, l\n')
    })
    it('-s adds blocks and a total, -i inodes', async () => {
      const r = await run('echo x > f', 'ls -s')
      expect(r.out).toMatch(/^total \d+\n\d+ f\n$/)
      const i = await run('echo x > f', 'ls -i')
      expect(i.out).toMatch(/^\d+ f\n$/)
    })
    it('-l hides owner and group, or shows numbers', async () => {
      const r = await run(setup, 'ls -lg a.c')
      expect(r.out).toMatch(/^-[rw-]{9} 1 \w+ 0 Jan  2  2020 a\.c\n$/)
      expect((await run(setup, 'ls -lG a.c')).out).toMatch(/^-[rw-]{9} 1 \w+ 0 Jan  2  2020 a\.c\n$/)
      expect((await run(setup, 'ls -n a.c')).out).toMatch(/^-[rw-]{9} 1 \d+ \d+ 0 Jan  2  2020 a\.c\n$/)
    })
    it('--time-style and --full-time', async () => {
      expect((await run(setup, 'ls -l --time-style=long-iso a.c')).out).toMatch(/ 0 2020-01-02 \d\d:04 a\.c\n$/)
      expect((await run(setup, 'ls -l --time-style=+%Y/%j a.c')).out).toMatch(/ 0 2020\/00[12] a\.c\n$/)
      expect((await run(setup, 'ls -l --time-style=iso a.c b.h')).out).toMatch(/ 0 2020-01-0[12]  a\.c\n.* 0 2024-03-0[45]  b\.h\n$/)
      expect((await run(setup, 'ls --full-time a.c')).out).toMatch(/ 0 2020-01-0[12] \d\d:\d\d:\d\d\.000000000 [+-]\d{4} a\.c\n$/)
    })
    it('-h prints one decimal below ten', async () => {
      expect((await run("head -c 4096 /dev/zero > big", 'ls -lh big')).out).toMatch(/ 4\.0K /)
    })
    it('-L shows the target, -l alone shows the link', async () => {
      const r = await run('echo hello > f; ln -s f l', 'ls -lL l')
      expect(r.out).toMatch(/^-[rw-]{9} 1 \w+ \w+ 6 .* l\n$/)
      expect((await run('echo hello > f; ln -s f l', 'ls -l l')).out).toMatch(/^lrwxrwxrwx 1 .* l -> f\n$/)
    })
    it('-R names subdirectories as typed, with ./ for the default', async () => {
      const r = await run('mkdir -p d/e; touch d/e/f', 'ls -R')
      expect(r.out).toBe('.:\nd\n\n./d:\ne\n\n./d/e:\nf\n')
      expect((await run('mkdir -p d/e', 'ls -R d')).out).toBe('d:\ne\n\nd/e:\n')
    })
    it('--file-type leaves out *, -F keeps it', async () => {
      expect((await run('touch x; chmod +x x; mkdir d', 'ls -1F')).out).toBe('d/\nx*\n')
      expect((await run('touch x; chmod +x x; mkdir d', 'ls -1 --file-type')).out).toBe('d/\nx\n')
    })
    it('reports bad options and arguments the way GNU does', async () => {
      expect((await run('', 'ls --zz')).err).toBe("ls: unrecognized option '--zz'\nTry 'ls --help' for more information.\n")
      expect((await run('', 'ls --sort=bogus')).err).toContain("ls: invalid argument 'bogus' for '--sort'\nValid arguments are:\n  - 'none'")
      expect((await run('', 'ls -w x')).err).toBe("ls: invalid line width: 'x'\nTry 'ls --help' for more information.\n")
      expect((await run('', 'ls -I')).err).toBe("ls: option requires an argument -- 'I'\nTry 'ls --help' for more information.\n")
    })
  })
  describe('chmod', () => {
    const mode = async (setup: string, command: string, file = 'f') => {
      const r = await run(`echo x > f; chmod 644 f; mkdir d; chmod 755 d; ${setup}`, `${command}; stat -c %a ${file}`)
      return { ...r, mode: r.out.trim() }
    }
    it('applies symbolic clauses', async () => {
      expect((await mode('', 'chmod u+x f')).mode).toBe('744')
      expect((await mode('', 'chmod go-r f')).mode).toBe('600')
      expect((await mode('', 'chmod a=rx f')).mode).toBe('555')
      expect((await mode('', 'chmod u=g f')).mode).toBe('444')
      expect((await mode('', 'chmod u+rwx,g+rx,o= f')).mode).toBe('750')
      expect((await mode('', 'chmod o+w,u-w f')).mode).toBe('446')
      expect((await mode('', 'chmod =r f')).mode).toBe('444')
    })
    it('a clause without a class applies the default umask', async () => {
      expect((await mode('', 'chmod +w f')).mode).toBe('644')
      expect((await mode('', 'chmod +x f')).mode).toBe('755')
      expect((await mode('', 'chmod g+w f')).mode).toBe('664')
    })
    it('sets setuid, setgid and sticky bits', async () => {
      expect((await mode('', 'chmod u+s f')).mode).toBe('4644')
      expect((await mode('', 'chmod g+s d', 'd')).mode).toBe('2755')
      expect((await mode('', 'chmod +t d', 'd')).mode).toBe('1755')
      expect((await mode('', 'chmod 7777 f')).mode).toBe('7777')
    })
    it('a directory keeps setgid under a short octal mode and loses it under a long one', async () => {
      expect((await mode('chmod g+s d', 'chmod 755 d', 'd')).mode).toBe('2755')
      expect((await mode('chmod g+s d', 'chmod 00755 d', 'd')).mode).toBe('755')
    })
    it('+X sets execute on directories and executable files only', async () => {
      const r = await run('mkdir -p t/sub; echo x > t/a; echo x > t/b; chmod 644 t/a t/b; chmod 744 t/b; chmod 600 t/sub', 'chmod -R a+X t; stat -c "%n %a" t/a t/b t/sub')
      expect(r.out).toBe('t/a 644\nt/b 755\nt/sub 711\n')
    })
    it('-R walks a tree and leaves symlinks alone', async () => {
      const r = await run('mkdir -p s/deep; echo x > s/x; echo x > s/deep/z; ln -s ../outside s/l; echo y > outside; chmod 644 outside', 'chmod -R 700 s; stat -c "%n %a" s s/x s/deep s/deep/z outside')
      expect(r.out).toBe('s 700\ns/x 700\ns/deep 700\ns/deep/z 700\noutside 644\n')
    })
    it('treats a leading-dash mode as a mode', async () => {
      expect((await mode('', 'chmod -x f')).mode).toBe('644')
      expect((await mode('chmod 755 f', 'chmod -- -x f')).mode).toBe('644')
      expect((await mode('chmod 755 f', 'chmod -w f')).mode).toBe('555')
    })
    it('follows --reference', async () => {
      const r = await run('echo x > a; echo x > b; chmod 751 a; chmod 600 b', 'chmod --reference=a b; stat -c %a b')
      expect(r.out).toBe('751\n')
    })
    it('-v and -c report changes in GNU words', async () => {
      const r = await run('echo x > f; chmod 644 f', '{ chmod -v 600 f; chmod -v 600 f; chmod -c 600 f; }')
      expect(r.out).toBe("mode of 'f' changed from 0644 (rw-r--r--) to 0600 (rw-------)\nmode of 'f' retained as 0600 (rw-------)\n")
    })
    it('reports bad modes, missing files and missing operands', async () => {
      expect((await run('', 'chmod zz f')).err).toBe("chmod: invalid mode: ‘zz’\nTry 'chmod --help' for more information.\n")
      expect((await run('', 'chmod 644 nope')).err).toBe("chmod: cannot access 'nope': No such file or directory\n")
      expect((await run('', 'chmod -f 644 nope')).err).toBe('')
      expect((await run('', 'chmod -f 644 nope')).code).toBe(1)
      expect((await run('', 'chmod 644')).err).toBe("chmod: missing operand after ‘644’\nTry 'chmod --help' for more information.\n")
      expect((await run('', 'chmod')).err).toBe("chmod: missing operand\nTry 'chmod --help' for more information.\n")
      expect((await run('ln -s gone dang', 'chmod 644 dang')).err).toBe("chmod: cannot operate on dangling symlink 'dang'\n")
    })
  })

  describe('mkdir', () => {
    it('creates a directory with 0777 less the default umask', async () => {
      expect((await run('', 'mkdir d; stat -c %a d')).out).toBe('755\n')
    })
    it('-m sets the mode exactly, octal or symbolic', async () => {
      expect((await run('', 'mkdir -m 700 d; stat -c %a d')).out).toBe('700\n')
      expect((await run('', 'mkdir -m u=rwx,g=,o= d; stat -c %a d')).out).toBe('700\n')
      expect((await run('', 'mkdir -m a+w d; stat -c %a d')).out).toBe('777\n')
      expect((await run('', 'mkdir -m zz d')).err).toBe('mkdir: invalid mode ‘zz’\n')
    })
    it('-p makes parents and accepts an existing directory', async () => {
      expect((await run('', 'mkdir -p a/b/c; ls -R a')).out).toBe('a:\nb\n\na/b:\nc\n\na/b/c:\n')
      expect((await run('mkdir d', 'mkdir -p d')).code).toBe(0)
    })
    it('-pm leaves the parents at the default mode', async () => {
      const r = await run('', 'mkdir -p -m 700 a/b; stat -c "%n %a" a a/b')
      expect(r.out).toBe('a 755\na/b 700\n')
    })
    it('-v names each directory created', async () => {
      expect((await run('', 'mkdir -v d e')).out).toBe("mkdir: created directory 'd'\nmkdir: created directory 'e'\n")
      expect((await run('', 'mkdir -pv a/b')).out).toBe("mkdir: created directory 'a'\nmkdir: created directory 'a/b'\n")
      expect((await run('mkdir a', 'mkdir -pv a/b')).out).toBe("mkdir: created directory 'a/b'\n")
    })
    it('reports an existing name, a missing parent and a file in the way', async () => {
      expect((await run('mkdir d', 'mkdir d')).err).toBe("mkdir: cannot create directory 'd': File exists\n")
      expect((await run('', 'mkdir a/b')).err).toBe("mkdir: cannot create directory 'a/b': No such file or directory\n")
      expect((await run('echo x > f', 'mkdir -p f/x')).err).toBe("mkdir: cannot create directory 'f': Not a directory\n")
      expect((await run('echo x > f', 'mkdir -p f')).err).toBe("mkdir: cannot create directory 'f': File exists\n")
      expect((await run('', 'mkdir')).err).toBe("mkdir: missing operand\nTry 'mkdir --help' for more information.\n")
    })
    it('keeps going after one failure', async () => {
      const r = await run('mkdir d', 'mkdir d e')
      expect(r.code).toBe(1)
      expect(await r.exists('e')).toBe(true)
    })
  })
  describe('du', () => {
    const tree = 'mkdir -p t/sub; head -c 5000 /dev/zero > t/a; echo x > t/sub/b; : > t/empty; ln -s a t/l; ln t/a t/hard'
    it('counts whole 4 KiB blocks, once per hard link, none for symlinks and empty files', async () => {
      expect((await run(tree, 'du -a t')).out).toBe('8\tt/a\n0\tt/empty\n0\tt/l\n4\tt/sub/b\n4\tt/sub\n12\tt\n')
    })
    it('-s, -d and -c', async () => {
      expect((await run(tree, 'du -s t')).out).toBe('12\tt\n')
      expect((await run(tree, 'du -d 0 t')).out).toBe('12\tt\n')
      expect((await run(tree, 'du -d 1 t')).out).toBe('4\tt/sub\n12\tt\n')
      expect((await run(tree, 'du -sc t/a t/sub')).out).toBe('8\tt/a\n4\tt/sub\n12\ttotal\n')
    })
    it('-b and --apparent-size use byte counts', async () => {
      expect((await run(tree, 'du -ab t/a t/sub/b')).out).toBe('5000\tt/a\n2\tt/sub/b\n')
      expect((await run(tree, 'du --apparent-size t/a')).out).toBe('5\tt/a\n')
    })
    it('-h, --si, -m and -B scale the sizes up', async () => {
      expect((await run(tree, 'du -h t/a')).out).toBe('8.0K\tt/a\n')
      expect((await run('head -c 1000000 /dev/zero > f', 'du --si --apparent-size f')).out).toBe('1.0M\tf\n')
      expect((await run('head -c 1000000 /dev/zero > f', 'du -m f')).out).toBe('1\tf\n')
      expect((await run('head -c 1000000 /dev/zero > f', 'du -B 512K f')).out).toBe('2\tf\n')
      expect((await run('head -c 1000000 /dev/zero > f', 'du -h --apparent-size f')).out).toBe('977K\tf\n')
    })
    it('-l counts every link, -S leaves out subdirectories', async () => {
      expect((await run(tree, 'du -s t/a t/hard')).out).toBe('8\tt/a\n')
      expect((await run(tree, 'du -sl t/a t/hard')).out).toBe('8\tt/a\n8\tt/hard\n')
      expect((await run(tree, 'du -S t')).out).toBe('4\tt/sub\n8\tt\n')
    })
    it('-L follows symlinks and -P does not', async () => {
      expect((await run('mkdir d; echo x > d/f; ln -s d l', 'du -L l')).out).toBe('4\tl\n')
      expect((await run('mkdir d; echo x > d/f; ln -s d l', 'du -P l')).out).toBe('0\tl\n')
      expect((await run('mkdir d; echo x > d/f; ln -s d l', 'du -D l')).out).toBe('4\tl\n')
    })
    it('--exclude and --time', async () => {
      expect((await run(tree, 'du -a --exclude=sub t')).out).toBe('8\tt/a\n0\tt/empty\n0\tt/l\n8\tt\n')
      expect((await run('TZ=UTC touch -d "2020-01-02 03:04" f', 'TZ=UTC du --time f')).out).toBe('0\t2020-01-02 03:04\tf\n')
    })
    it('-0 ends each line with NUL, -t drops small entries', async () => {
      expect((await run(tree, 'du -0 -s t | od -c')).out).toContain('\\0')
      expect((await run(tree, 'du -a -t 1 t')).out).toBe('8\tt/a\n4\tt/sub/b\n4\tt/sub\n12\tt\n')
    })
    it('reports bad arguments and missing files', async () => {
      expect((await run('', 'du nope')).err).toBe("du: cannot access 'nope': No such file or directory\n")
      expect((await run('', 'du nope')).code).toBe(1)
      expect((await run('', 'du -d x')).err).toBe("du: invalid maximum depth 'x'\n")
      expect((await run('', 'du --zz')).err).toBe("du: unrecognized option '--zz'\nTry 'du --help' for more information.\n")
    })
  })
})
