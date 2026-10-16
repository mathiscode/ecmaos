import { describe, expect, it } from 'vitest'

import { usePosixKernel } from './fixtures/posix-fileops'

/** POSIX file operations against what GNU coreutils do (file and directory commands: rmdir to stat); the expected values were taken from GNU coreutils 9. */
describe('POSIX file operations', { timeout: 120000 }, () => {
  const posix = usePosixKernel()
  const { run, fs } = posix

  describe('rmdir', () => {
    it('removes an empty directory', async () => {
      const r = await run('mkdir d', 'rmdir d')
      expect(r.code).toBe(0)
      expect(await r.exists('d')).toBe(false)
    })
    it('refuses a directory with files in it and leaves them', async () => {
      const r = await run('mkdir d; echo x > d/f', 'rmdir d')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rmdir: failed to remove 'd': Directory not empty\n")
      expect(await r.exists('d/f')).toBe(true)
    })
    it('refuses a file', async () => {
      const r = await run('echo x > f', 'rmdir f')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rmdir: failed to remove 'f': Not a directory\n")
      expect(await r.exists('f')).toBe(true)
    })
    it('reports a missing directory', async () => {
      const r = await run('', 'rmdir nope')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rmdir: failed to remove 'nope': No such file or directory\n")
    })
    it('-p removes the empty parents too', async () => {
      const r = await run('mkdir -p a/b/c', 'rmdir -p a/b/c')
      expect(r.code).toBe(0)
      expect(await r.exists('a')).toBe(false)
    })
    it('-p stops at the first parent that is not empty', async () => {
      const r = await run('mkdir -p a/b/c; echo x > a/f', 'rmdir -p a/b/c')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rmdir: failed to remove 'a': Directory not empty\n")
      expect(await r.exists('a/b')).toBe(false)
      expect(await r.exists('a/f')).toBe(true)
    })
    it('--ignore-fail-on-non-empty keeps quiet', async () => {
      const r = await run('mkdir d; echo x > d/f', 'rmdir --ignore-fail-on-non-empty d')
      expect(r.code).toBe(0)
      expect(r.err).toBe('')
      expect(await r.exists('d/f')).toBe(true)
    })
    it('-v names each directory', async () => {
      const r = await run('mkdir d', 'rmdir -v d')
      expect(r.out).toBe("rmdir: removing directory, 'd'\n")
    })
    it('needs an operand', async () => {
      const r = await run('', 'rmdir')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rmdir: missing operand\nTry 'rmdir --help' for more information.\n")
    })
  })

  describe('rm', () => {
    it('removes a file', async () => {
      const r = await run('echo x > f', 'rm f')
      expect(r.code).toBe(0)
      expect(await r.exists('f')).toBe(false)
    })
    it('does not glob a quoted pattern', async () => {
      const r = await run('echo x > a; echo y > "*"', "rm '*'")
      expect(r.code).toBe(0)
      expect(await r.exists('a')).toBe(true)
      expect(await r.exists('*')).toBe(false)
    })
    it('refuses a directory without -r', async () => {
      const r = await run('mkdir d', 'rm d')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rm: cannot remove 'd': Is a directory\n")
      expect(await r.exists('d')).toBe(true)
    })
    it('-r removes a tree and -v lists it children first', async () => {
      const r = await run('mkdir -p d/e; echo x > d/e/f', 'rm -rv d')
      expect(r.code).toBe(0)
      expect(r.out).toBe("removed 'd/e/f'\nremoved directory 'd/e'\nremoved directory 'd'\n")
      expect(await r.exists('d')).toBe(false)
    })
    it('-r removes a symlink to a directory without touching the target', async () => {
      const r = await run('mkdir keep; echo x > keep/f; mkdir d; ln -s ../keep d/link', 'rm -r d')
      expect(r.code).toBe(0)
      expect(await r.exists('keep/f')).toBe(true)
      expect(await r.exists('d')).toBe(false)
    })
    it('reports a missing file, and -f is quiet about it', async () => {
      const a = await run('', 'rm nope')
      expect(a.code).toBe(1)
      expect(a.err).toBe("rm: cannot remove 'nope': No such file or directory\n")
      const b = await run('', 'rm -f nope')
      expect(b.code).toBe(0)
      expect(b.err).toBe('')
    })
    it('-f with no operand succeeds; without -f it names the problem', async () => {
      expect((await run('', 'rm -f')).code).toBe(0)
      const r = await run('', 'rm')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rm: missing operand\nTry 'rm --help' for more information.\n")
    })
    it('refuses . and .. and removes nothing', async () => {
      const r = await run('mkdir d; echo x > d/f; echo y > g', 'cd d; rm -rf .')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rm: refusing to remove '.' or '..' directory: skipping '.'\n")
      expect(await r.exists('d/f')).toBe(true)
    })
    it('protects /', async () => {
      const r = await run('', 'rm -r /')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n")
    })
    it('-d removes an empty directory but not a full one', async () => {
      const r = await run('mkdir e f; echo x > f/g', 'rm -d e f')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rm: cannot remove 'f': Directory not empty\n")
      expect(await r.exists('e')).toBe(false)
    })
    it('options may follow the operands, and -- ends them', async () => {
      const r = await run('echo x > a; echo y > -f', 'rm a -- -f')
      expect(r.code).toBe(0)
      expect(await r.exists('a')).toBe(false)
      expect(await r.exists('-f')).toBe(false)
    })
    it('rejects an unknown option', async () => {
      const r = await run('', 'rm -z a')
      expect(r.code).toBe(1)
      expect(r.err).toBe("rm: invalid option -- 'z'\nTry 'rm --help' for more information.\n")
    })
    it('-i removes only what is answered yes', async () => {
      const r = await run('echo x > a; echo y > b', "printf 'y\\nn\\n' | rm -i a b")
      expect(r.code).toBe(0)
      expect(r.err).toBe("rm: remove regular file 'a'? rm: remove regular file 'b'? ")
      expect(await r.exists('a')).toBe(false)
      expect(await r.exists('b')).toBe(true)
    })
  })

  describe('ln', () => {
    it('makes a hard link to a file', async () => {
      const r = await run('echo x > a', 'ln a b; cat b')
      expect(r.out).toBe('x\n')
    })
    it('stores a symlink target as given, relative or dangling', async () => {
      const r = await run('mkdir d', 'ln -s ../nothing d/l; readlink d/l')
      expect(r.code).toBe(0)
      expect(r.out).toBe('../nothing\n')
    })
    it('-r stores a relative target', async () => {
      const r = await run('mkdir d; echo x > f', 'ln -sr f d/l; readlink d/l')
      expect(r.out).toBe('../f\n')
    })
    it('refuses a hard link to a directory', async () => {
      const r = await run('mkdir d', 'ln d e')
      expect(r.code).toBe(1)
      expect(r.err).toBe("ln: 'd': hard link not allowed for directory\n")
    })
    it('reports an existing destination, and -f replaces it', async () => {
      const a = await run('echo x > a; echo y > b', 'ln a b')
      expect(a.code).toBe(1)
      expect(a.err).toBe("ln: failed to create hard link 'b' => 'a': File exists\n")
      const b = await run('echo x > a; echo y > b', 'ln -f a b; cat b')
      expect(b.out).toBe('x\n')
    })
    it('links into a directory with several targets', async () => {
      const r = await run('mkdir d; echo 1 > a; echo 2 > b', 'ln -s ../a ../b d; ls d')
      expect(r.code).toBe(0)
      expect(r.out).toBe('a\nb\n')
    })
    it('-t names the directory', async () => {
      const r = await run('mkdir d; echo 1 > a', 'ln -t d a; cat d/a')
      expect(r.out).toBe('1\n')
    })
    it('with one operand links into the current directory', async () => {
      const r = await run('mkdir d; echo 1 > d/a', 'ln -s d/a; readlink a')
      expect(r.out).toBe('d/a\n')
    })
  })

  describe('cp', () => {
    it('copies a file and leaves the source', async () => {
      const r = await run('echo x > a', 'cp a b; cat b')
      expect(r.out).toBe('x\n')
      expect(await r.exists('a')).toBe(true)
    })
    it('refuses to copy a file onto itself and does not truncate it', async () => {
      const r = await run('echo x > a', 'cp a a')
      expect(r.code).toBe(1)
      expect(r.err).toBe("cp: 'a' and 'a' are the same file\n")
      expect(await fs().readFile(`${r.dir}/a`, 'utf-8')).toBe('x\n')
    })
    it('refuses to copy onto a hard link of itself', async () => {
      const r = await run('echo x > a; ln a b', 'cp a b')
      expect(r.err).toBe("cp: 'a' and 'b' are the same file\n")
      expect(await fs().readFile(`${r.dir}/a`, 'utf-8')).toBe('x\n')
    })
    it('refuses to copy a directory into itself', async () => {
      const r = await run('mkdir -p d/sub; echo x > d/f', 'cp -r d d/sub/deep')
      expect(r.code).toBe(1)
      expect(r.err).toBe("cp: cannot copy a directory, 'd', into itself, 'd/sub/deep'\n")
      expect(await r.exists('d/sub/deep')).toBe(false)
    })
    it('copies . into a subdirectory only once', async () => {
      const r = await run('mkdir sub; echo x > f', 'cp -r . sub')
      expect(r.err).toBe("cp: cannot copy a directory, '.', into itself, 'sub/.'\n")
    })
    it('omits a directory without -r', async () => {
      const r = await run('mkdir d', 'cp d e')
      expect(r.code).toBe(1)
      expect(r.err).toBe("cp: -r not specified; omitting directory 'd'\n")
    })
    it('-r copies a tree and -v lists it', async () => {
      const r = await run('mkdir -p d/e; echo x > d/e/f', 'cp -rv d g')
      expect(r.code).toBe(0)
      expect(r.out.split('\n').sort()).toEqual(['', "'d' -> 'g'", "'d/e' -> 'g/e'", "'d/e/f' -> 'g/e/f'"])
      expect(await fs().readFile(`${r.dir}/g/e/f`, 'utf-8')).toBe('x\n')
    })
    it('copies into an existing directory', async () => {
      const r = await run('mkdir d; echo x > a', 'cp a d; cat d/a')
      expect(r.out).toBe('x\n')
    })
    it('-r keeps symlinks as symlinks, without -r they are followed', async () => {
      const a = await run('echo x > t; ln -s t l', 'cp -r l m; readlink m')
      expect(a.out).toBe('t\n')
      const b = await run('echo x > t; ln -s t l', 'cp l m; cat m')
      expect(b.out).toBe('x\n')
    })
    it('names a missing source', async () => {
      const r = await run('', 'cp nope b')
      expect(r.code).toBe(1)
      expect(r.err).toBe("cp: cannot stat 'nope': No such file or directory\n")
    })
    it('needs a directory for several sources', async () => {
      const r = await run('echo 1 > a; echo 2 > b; echo 3 > c', 'cp a b c')
      expect(r.code).toBe(1)
      expect(r.err).toBe("cp: target 'c' is not a directory\n")
    })
    it('-n keeps an existing destination', async () => {
      const r = await run('echo 1 > a; echo 2 > b', 'cp -n a b; cat b')
      expect(r.out).toBe('2\n')
    })
    it('-t names the directory and options may follow operands', async () => {
      const r = await run('mkdir d; echo 1 > a', 'cp a -t d; cat d/a')
      expect(r.out).toBe('1\n')
    })
    it('-T copies onto the name, not into a directory', async () => {
      const r = await run('mkdir d; echo 1 > a', 'cp -T a d')
      expect(r.code).toBe(1)
      expect(r.err).toBe("cp: cannot overwrite directory 'd' with non-directory 'a'\n")
    })
  })

  describe('mv', () => {
    it('renames a file', async () => {
      const r = await run('echo x > a', 'mv a b; cat b')
      expect(r.out).toBe('x\n')
      expect(await r.exists('a')).toBe(false)
    })
    it('replaces an existing file', async () => {
      const r = await run('echo 1 > a; echo 2 > b', 'mv a b; cat b')
      expect(r.out).toBe('1\n')
    })
    it('-n and -i can keep the destination', async () => {
      const a = await run('echo 1 > a; echo 2 > b', 'mv -n a b; cat b')
      expect(a.out).toBe('2\n')
      expect(await a.exists('a')).toBe(true)
      const b = await run('echo 1 > a; echo 2 > b', "echo n | mv -i a b")
      expect(b.err).toBe("mv: overwrite 'b'? mv: not replacing 'b'\n")
      expect(await b.exists('a')).toBe(true)
    })
    it('refuses a file onto itself and leaves it', async () => {
      const r = await run('echo x > a', 'mv a a')
      expect(r.code).toBe(1)
      expect(r.err).toBe("mv: 'a' and 'a' are the same file\n")
      expect(await fs().readFile(`${r.dir}/a`, 'utf-8')).toBe('x\n')
    })
    it('moves into a directory, with several sources', async () => {
      const r = await run('mkdir d; echo 1 > a; echo 2 > b', 'mv a b d; ls d')
      expect(r.out).toBe('a\nb\n')
      expect(await r.exists('a')).toBe(false)
    })
    it('needs a directory for several sources', async () => {
      const r = await run('echo 1 > a; echo 2 > b; echo 3 > c', 'mv a b c')
      expect(r.code).toBe(1)
      expect(r.err).toBe("mv: target 'c' is not a directory\n")
      expect(await r.exists('a')).toBe(true)
    })
    it('refuses a directory into itself', async () => {
      const r = await run('mkdir -p d/sub', 'mv d d/sub')
      expect(r.code).toBe(1)
      expect(r.err).toBe("mv: cannot move 'd' to a subdirectory of itself, 'd/sub/d'\n")
      expect(await r.exists('d/sub')).toBe(true)
    })
    it('refuses a directory onto a non-empty directory', async () => {
      const r = await run('mkdir a b; echo x > b/f', 'mv -T a b')
      expect(r.code).toBe(1)
      expect(r.err).toBe("mv: cannot move 'a' to 'b': Directory not empty\n")
      expect(await r.exists('b/f')).toBe(true)
      expect(await r.exists('a')).toBe(true)
    })
    it('replaces an empty directory with a directory', async () => {
      const r = await run('mkdir a b; echo x > a/f', 'mv -T a b')
      expect(r.code).toBe(0)
      expect(await r.exists('b/f')).toBe(true)
      expect(await r.exists('a')).toBe(false)
    })
    it('refuses a directory onto a file', async () => {
      const r = await run('mkdir a; echo x > f', 'mv a f')
      expect(r.err).toBe("mv: cannot overwrite non-directory 'f' with directory 'a'\n")
    })
    it('names a missing source and -v reports a move', async () => {
      const a = await run('', 'mv nope b')
      expect(a.err).toBe("mv: cannot stat 'nope': No such file or directory\n")
      const b = await run('echo x > a', 'mv -v a b')
      expect(b.out).toBe("renamed 'a' -> 'b'\n")
    })
    it('-t names the directory', async () => {
      const r = await run('mkdir d; echo 1 > a', 'mv a -t d; ls d')
      expect(r.out).toBe('a\n')
    })
    it('cannot move a file in /proc', async () => {
      const r = await run('', 'mv /proc/uptime /tmp/posix/uptime-moved')
      expect(r.code).toBe(1)
    })
  })

  describe('touch', () => {
    const mtime = async (r: { dir: string }, name: string) => Math.floor(((await fs().stat(`${r.dir}/${name}`)).mtimeMs) / 1000)
    const atime = async (r: { dir: string }, name: string) => Math.floor(((await fs().stat(`${r.dir}/${name}`)).atimeMs) / 1000)

    it('creates a missing file and -c does not', async () => {
      const a = await run('', 'touch f')
      expect(await a.exists('f')).toBe(true)
      const b = await run('', 'touch -c f')
      expect(b.code).toBe(0)
      expect(await b.exists('f')).toBe(false)
    })
    it('-d sets both times from a date string', async () => {
      const r = await run('echo x > f', "touch -d '2020-01-02 03:04:05 UTC' f")
      expect(r.code).toBe(0)
      expect(await mtime(r, 'f')).toBe(Date.UTC(2020, 0, 2, 3, 4, 5) / 1000)
      expect(await atime(r, 'f')).toBe(Date.UTC(2020, 0, 2, 3, 4, 5) / 1000)
    })
    it('-t sets the time from a stamp', async () => {
      const r = await run('echo x > f', 'touch -t 202001020304.05 f')
      expect(await mtime(r, 'f')).toBe(new Date(2020, 0, 2, 3, 4, 5).getTime() / 1000)
    })
    it('-m leaves the access time and -a leaves the modification time', async () => {
      const r = await run("echo x > f; touch -d '2000-01-01 00:00 UTC' f", "touch -m -d '2010-01-01 00:00 UTC' f")
      expect(await mtime(r, 'f')).toBe(Date.UTC(2010, 0, 1) / 1000)
      expect(await atime(r, 'f')).toBe(Date.UTC(2000, 0, 1) / 1000)
      const s = await run("echo x > f; touch -d '2000-01-01 00:00 UTC' f", "touch -a -d '2010-01-01 00:00 UTC' f")
      expect(await atime(s, 'f')).toBe(Date.UTC(2010, 0, 1) / 1000)
      expect(await mtime(s, 'f')).toBe(Date.UTC(2000, 0, 1) / 1000)
    })
    it('-r copies the times of another file', async () => {
      const r = await run("echo x > a; echo y > b; touch -d '2001-02-03 04:05 UTC' a", 'touch -r a b')
      expect(await mtime(r, 'b')).toBe(Date.UTC(2001, 1, 3, 4, 5) / 1000)
    })
    it('treats an option as an option, not a file name', async () => {
      const r = await run('', 'touch -- -c')
      expect(await r.exists('-c')).toBe(true)
      const s = await run('', 'touch f -a')
      expect(await s.exists('-a')).toBe(false)
      expect(await s.exists('f')).toBe(true)
    })
    it('rejects a bad date and a missing operand', async () => {
      const a = await run('', "touch -d banana f")
      expect(a.code).toBe(1)
      expect(a.err).toBe("touch: invalid date format 'banana'\n")
      const b = await run('', 'touch')
      expect(b.err).toBe("touch: missing file operand\nTry 'touch --help' for more information.\n")
    })
    it('cannot create under a missing directory', async () => {
      const r = await run('', 'touch nodir/f')
      expect(r.code).toBe(1)
      expect(r.err).toBe("touch: cannot touch 'nodir/f': No such file or directory\n")
    })
  })

  describe('find', () => {
    const lines = (text: string) => text.split('\n').filter(Boolean).sort()
    const tree = 'mkdir -p d/sub d/empty; echo hello > d/a.txt; echo hi > d/sub/b.txt; : > d/sub/c.log; ln -s a.txt d/link; mkdir d/.hid; : > d/.hid/x'

    it('lists everything under a directory, given as typed', async () => {
      const r = await run(tree, 'find d')
      expect(lines(r.out)).toEqual(['d', 'd/.hid', 'd/.hid/x', 'd/a.txt', 'd/empty', 'd/link', 'd/sub', 'd/sub/b.txt', 'd/sub/c.log'])
    })
    it('defaults the start to . and prints nothing for no match', async () => {
      const r = await run('echo x > f', 'find')
      expect(lines(r.out)).toEqual(['.', './f'])
    })
    it('-name globs the base name, including dotfiles, and -iname ignores case', async () => {
      expect(lines((await run(tree, "find d -name '*.txt'")).out)).toEqual(['d/a.txt', 'd/sub/b.txt'])
      expect(lines((await run(tree, "find d -iname 'A.TXT'")).out)).toEqual(['d/a.txt'])
      expect(lines((await run(tree, "find d -name '.*'")).out)).toEqual(['d/.hid'])
    })
    it('-type picks files, directories and links', async () => {
      expect(lines((await run(tree, 'find d -type l')).out)).toEqual(['d/link'])
      expect(lines((await run(tree, 'find d -type d')).out)).toEqual(['d', 'd/.hid', 'd/empty', 'd/sub'])
      expect(lines((await run(tree, 'find d -type f,l')).out)).toEqual(['d/.hid/x', 'd/a.txt', 'd/link', 'd/sub/b.txt', 'd/sub/c.log'])
    })
    it('combines tests with !, -o and parentheses', async () => {
      expect(lines((await run(tree, "find d -type f ! -name '*.txt'")).out)).toEqual(['d/.hid/x', 'd/sub/c.log'])
      expect(lines((await run(tree, "find d -type f \\( -name '*.txt' -o -name '*.log' \\)")).out)).toEqual(['d/a.txt', 'd/sub/b.txt', 'd/sub/c.log'])
    })
    it('-maxdepth and -mindepth limit the walk', async () => {
      expect(lines((await run(tree, 'find d -maxdepth 1')).out)).toEqual(['d', 'd/.hid', 'd/a.txt', 'd/empty', 'd/link', 'd/sub'])
      expect(lines((await run(tree, 'find d -mindepth 2')).out)).toEqual(['d/.hid/x', 'd/sub/b.txt', 'd/sub/c.log'])
    })
    it('-empty finds empty files and directories', async () => {
      expect(lines((await run(tree, 'find d -empty')).out)).toEqual(['d/.hid/x', 'd/empty', 'd/sub/c.log'])
    })
    it('-size compares in the given unit, rounding up', async () => {
      expect(lines((await run(tree, 'find d -type f -size -1c')).out)).toEqual(['d/.hid/x', 'd/sub/c.log'])
      expect(lines((await run(tree, 'find d -type f -size +5c')).out)).toEqual(['d/a.txt'])
      expect(lines((await run(tree, 'find d -type f -size 1')).out)).toEqual(['d/a.txt', 'd/sub/b.txt'])
    })
    it('-path matches the whole path', async () => {
      expect(lines((await run(tree, "find d -path 'd/sub/*'")).out)).toEqual(['d/sub/b.txt', 'd/sub/c.log'])
    })
    it('-prune skips a directory', async () => {
      expect(lines((await run(tree, "find d -name sub -prune -o -type f -print")).out)).toEqual(['d/.hid/x', 'd/a.txt'])
    })
    it('-print0 and -printf format the output', async () => {
      expect((await run(tree, 'find d -maxdepth 0 -print0')).out).toBe('d\0')
      expect(lines((await run(tree, "find d -type f -printf '%f %s %y %d\\n'")).out)).toEqual(['a.txt 6 f 1', 'b.txt 3 f 2', 'c.log 0 f 2', 'x 0 f 2'])
      expect((await run(tree, "find d -name a.txt -printf '%p|%h|%P|%m|%M\\n'")).out).toBe('d/a.txt|d|a.txt|644|-rw-r--r--\n')
    })
    it('-exec runs a command per file and -exec + batches them', async () => {
      const a = await run(tree, "find d -name '*.txt' -exec echo got {} \\;")
      expect(lines(a.out)).toEqual(['got d/a.txt', 'got d/sub/b.txt'])
      const b = await run(tree, "find d -name '*.txt' -exec echo {} +")
      expect(b.out.split(' ').length).toBeGreaterThan(1)
      expect(b.out.trim().split(/\s+/).sort()).toEqual(['d/a.txt', 'd/sub/b.txt'])
    })
    it('-exec takes its truth from the command', async () => {
      const r = await run(tree, "find d -name a.txt -exec false {} \\; -o -name a.txt -print")
      expect(r.out).toBe('d/a.txt\n')
    })
    it('-delete removes files and, depth first, directories', async () => {
      const r = await run(tree, 'find d/sub -delete')
      expect(r.code).toBe(0)
      expect(await r.exists('d/sub')).toBe(false)
      expect(await r.exists('d/a.txt')).toBe(true)
    })
    it('-newer, -mtime and -perm', async () => {
      const r = await run("mkdir d; touch -d '2001-01-01 UTC' d/old; touch d/new; chmod 600 d/new", 'find d -type f -newer d/old')
      expect(r.out).toBe('d/new\n')
      const b = await run("mkdir d; touch -d '2001-01-01 UTC' d/old; touch d/new; chmod 600 d/new", 'find d -type f -mtime +30')
      expect(b.out).toBe('d/old\n')
      const c = await run("mkdir d; touch d/new; chmod 600 d/new; touch d/other", 'find d -type f -perm 600')
      expect(c.out).toBe('d/new\n')
      const e = await run("mkdir d; touch d/new; chmod 755 d/new; touch d/other", 'find d -type f -perm -u+x')
      expect(e.out).toBe('d/new\n')
    })
    it('-regex matches the whole path', async () => {
      const r = await run(tree, "find d -regex 'd/sub/.*\\.txt'")
      expect(r.out).toBe('d/sub/b.txt\n')
    })
    it('does not descend into a symlinked directory unless -L', async () => {
      const setup = 'mkdir -p real/inner; : > real/inner/f; mkdir top; ln -s ../real top/l'
      expect(lines((await run(setup, 'find top')).out)).toEqual(['top', 'top/l'])
      expect(lines((await run(setup, 'find -L top')).out)).toEqual(['top', 'top/l', 'top/l/inner', 'top/l/inner/f'])
    })
    it('reports a missing start point and keeps going', async () => {
      const r = await run('mkdir d', 'find nope d')
      expect(r.code).toBe(1)
      expect(r.err).toBe("find: 'nope': No such file or directory\n")
      expect(r.out).toBe('d\n')
    })
    it('reports bad expressions the way GNU does', async () => {
      const cases: Array<[string, string]> = [
        ['find . -foo', "find: unknown predicate `-foo'\n"],
        ['find . -name', "find: missing argument to `-name'\n"],
        ['find . -type z', 'find: Unknown argument to -type: z\n'],
        ['find . -mtime x', "find: invalid argument `x' to `-mtime'\n"],
        ['find . -size 5x', "find: invalid -size type `x'\n"],
        ['find . -name a b', "find: paths must precede expression: `b'\n"],
        ['find . -maxdepth -1', "find: Expected a positive decimal integer argument to -maxdepth, but got '-1'\n"]
      ]
      for (const [command, expected] of cases) {
        const r = await run('', command)
        expect(r.code, command).toBe(1)
        expect(r.err, command).toBe(expected)
      }
    })
  })

  describe('backups and cp extras', () => {
    it('cp -b keeps the old file as name~', async () => {
      const r = await run('echo A > a; echo B > b', '{ cp -b a b; cat b b~; }')
      expect(r.out).toBe('A\nB\n')
    })
    it('numbers backups with --backup=numbered, and -S sets the simple suffix', async () => {
      const r = await run('echo A > a; echo B > b', '{ cp --backup=numbered a b; cp --backup=numbered a b; ls; }')
      expect(r.out).toBe('a\nb\nb.~1~\nb.~2~\n')
      const s = await run('echo A > a; echo B > b', '{ cp -b -S .bak a b; ls; }')
      expect(s.out).toBe('a\nb\nb.bak\n')
    })
    it('mv -b and ln -sb back up the destination', async () => {
      const m = await run('echo A > a; echo B > b', '{ mv -b a b; ls; cat b b~; }')
      expect(m.out).toBe('b\nb~\nA\nB\n')
      const l = await run('echo A > a; echo B > b', '{ ln -sb a b; cat b~; readlink b; }')
      expect(l.out).toBe('B\na\n')
    })
    it('rejects an unknown backup type with the valid names', async () => {
      const r = await run('echo A > a', 'cp --backup=bogus a b')
      expect(r.code).toBe(1)
      expect(r.err).toContain("cp: invalid argument 'bogus' for 'backup type'\nValid arguments are:")
    })
    it('cp --parents recreates the source path under the directory', async () => {
      const r = await run('mkdir -p sub/x t; echo 1 > sub/x/f', '{ cp --parents sub/x/f t; cat t/sub/x/f; }')
      expect(r.out).toBe('1\n')
    })
    it('cp -s stores the source name as given, and refuses a relative one elsewhere', async () => {
      const r = await run('echo A > a', '{ cp -s a c; readlink c; }')
      expect(r.out).toBe('a\n')
      const s = await run('echo A > a; mkdir d', 'cp -s a d/c')
      expect(s.code).toBe(1)
      expect(s.err).toBe("cp: cannot create symbolic link 'd/c': can make relative symbolic links only in current directory\n")
    })
  })

  describe('find -ls', () => {
    it('shows 1 KiB block counts and escapes blanks in names and targets', async () => {
      const r = await run('mkdir d; echo hi > "s p.txt"; ln -s "s p.txt" l', 'find . -ls | sed "s/^ *[0-9]* *//; s/ [A-Z][a-z][a-z] .*[0-9:] / /"')
      expect(r.out).toContain('0 drwx')
      expect(r.out).toContain('4 -rw-r--r--   1 root     root            3 ./s\\ p.txt')
      expect(r.out).toContain('0 lrwxrwxrwx   1 root     root            7 ./l -> s\\ p.txt')
    })
  })

  describe('touch and ls extras', () => {
    it('touch -c skips a dangling symlink without an error', async () => {
      const r = await run('ln -s nowhere d', '{ touch -c d; echo $?; ls; }')
      expect(r.out).toBe('0\nd\n')
      expect(r.err).toBe('')
    })
    it('touch on a dangling symlink creates the file it names', async () => {
      const r = await run('ln -s nowhere d', '{ touch d; echo $?; ls; }')
      expect(r.out).toBe('0\nd\nnowhere\n')
    })
    it('ls counts whole 4 KiB blocks in KiB, and none for a directory or symlink', async () => {
      const r = await run('mkdir x; echo a > x/f; ln -s f x/l; : > x/e', '{ ls -s x; ls -l x | head -1; }')
      expect(r.out).toBe('total 4\n0 e\n4 f\n0 l\ntotal 4\n')
    })
  })

  describe('date, stat and timeout extras', () => {
    it('date -u reads a date string as UTC', async () => {
      const r = await run('', '{ date -u -d "2020-02-29" +%s; date -u -d "12:30" +%R; date -u -d "01/05/2020" +%F; }')
      expect(r.out).toBe('1582934400\n12:30\n2020-01-05\n')
    })
    it('date -f prints each line and reports a bad one', async () => {
      const r = await run('printf "2020-01-02\\n@0\\nbogus\\n" > l', '{ date -u -f l +%F; echo $?; }')
      expect(r.out).toBe('2020-01-02\n1970-01-01\n1\n')
      expect(r.err).toBe("date: invalid date 'bogus'\n")
    })
    it('stat counts 512-byte blocks of whole 4 KiB, and splits a device number as major:minor', async () => {
      const r = await run('echo hello > a', '{ stat -c "%b %B %s" a; stat -c %t:%T /dev/null; }')
      expect(r.out).toBe('8 512 6\n1:3\n')
    })
    it('timeout prints only the hint for a missing operand, and names why a command cannot run', async () => {
      const a = await run('', 'timeout 1')
      expect(a.code).toBe(125)
      expect(a.err).toBe("Try 'timeout --help' for more information.\n")
      const b = await run('', 'timeout 1 nonexistcmd')
      expect(b.code).toBe(127)
      expect(b.err).toBe("timeout: failed to run command \u2018nonexistcmd\u2019: No such file or directory\n")
    })
  })

  describe('mktemp templates', () => {
    it('replaces the whole run of X, including 3 to 5 of them', async () => {
      const r = await run('', '{ mktemp XXX | grep -c "^[A-Za-z0-9]\\{3\\}$"; mktemp fooXXXXXX | grep -c "^foo[A-Za-z0-9]\\{6\\}$"; ls | grep -c XXX; }')
      expect(r.out).toBe('1\n1\n0\n')
    })
  })

  describe('type flags', () => {
    it('takes clustered flags and -- before the names', async () => {
      const r = await run('', '{ type -a ls; type -ap ls; type -- ls; }')
      expect(r.out).toBe('ls is /bin/ls\n/bin/ls\nls is /bin/ls\n')
      expect(r.err).toBe('')
    })
  })

  describe('yes, tty, logname and which', () => {
    it('yes takes options as GNU does', async () => {
      const a = await run('', 'yes -n')
      expect(a.code).toBe(1)
      expect(a.err).toBe("yes: invalid option -- 'n'\nTry 'yes --help' for more information.\n")
      const b = await run('', 'yes -- -n | head -1')
      expect(b.out).toBe('-n\n')
    })
    it('tty says not a tty for a standard input that is no terminal, and -s is silent', async () => {
      const a = await run('', '{ tty </dev/null; echo $?; tty -s </dev/null; echo $?; }')
      expect(a.out).toBe('not a tty\n1\n1\n')
    })
    it('logname prints the login name', async () => {
      const r = await run('', '{ LOGNAME=bob logname; logname extra; echo $?; }')
      expect(r.out).toBe('bob\n1\n')
      expect(r.err).toContain("logname: extra operand")
    })
    it('which with no operand writes its usage to standard error', async () => {
      const r = await run('', 'which')
      expect(r.code).toBe(255)
      expect(r.out).toBe('')
      expect(r.err).toContain('Usage: which')
    })
  })

  describe('nproc', () => {
    it('takes --all, --ignore and OMP_NUM_THREADS, never below 1, and rejects operands', async () => {
      const r = await run('', '{ nproc --ignore=100; OMP_NUM_THREADS=3 nproc; OMP_NUM_THREADS=3 nproc --all | grep -c "^[0-9]*$"; nproc extra; echo $?; }')
      expect(r.out).toBe('1\n3\n1\n1\n')
      expect(r.err).toBe("nproc: extra operand \u2018extra\u2019\nTry 'nproc --help' for more information.\n")
    })
  })

  describe('quoted strings over several lines', () => {
    it('runs a script whose string spans lines, in a group, a function and a substitution', async () => {
      const r = await run('', "{ echo 'a\nb'; f() { echo \"p\nq\"; }; f; x=$(echo \"m\n# n\"); echo \"$x\"; }")
      expect(r.out).toBe('a\nb\np\nq\nm\n# n\n')
    })
  })

  describe('read, trap and shell diagnostics', () => {
    it('joins a line ended by a backslash unless -r, and reports a last line without a newline', async () => {
      const r = await run('', "{ printf 'a\\\nb\n' | { read x; echo \"[$x]\"; }; printf 'a\\\nb\n' | { read -r x; echo \"[$x]\"; }; printf abc | { read x; echo \"$? [$x]\"; }; }")
      expect(r.out).toBe('[ab]\n[a\\]\n1 [abc]\n')
    })
    it('sends set -x traces and refused assignments to a block\'s standard error', async () => {
      const r = await run('', "{ { set -x; echo hi; set +x; readonly c=1; c=2; } 2>err\necho ---; cat err\n}")
      expect(r.out).toBe('hi\n---\n+ echo hi\n+ set +x\necmaos: c: readonly variable\n')
    })
    it('trap -p names a signal with its SIG prefix', async () => {
      const r = await run('', "{ trap 'echo x' EXIT INT; trap -p; trap - EXIT INT; }")
      expect(r.out).toBe("trap -- 'echo x' EXIT\ntrap -- 'echo x' SIGINT\n")
    })
    it('getopts reports an illegal option without a getopts prefix', async () => {
      const r = await run('', 'f(){ while getopts "ab" o; do echo "$o"; done; }; f -x -a')
      expect(r.out).toBe('?\na\n')
      expect(r.err).toBe('ecmaos: illegal option -- x\n')
    })
  })

  describe('declare and expansion details', () => {
    it('knows declare -x/-g/-p on unset locals, $arr as element 0, and & in a replacement', async () => {
      const r = await run('', "{ declare -x y=2; declare -p y; f(){ local a=1 b; declare -p a b; local gg=1; declare -g gg=5; echo $FUNCNAME; }; f; echo $gg; a=(x y); echo $a; s=abc; echo ${s/b/[&]} ${s/b/\\&}; }")
      expect(r.out).toBe('declare -x y="2"\ndeclare -- a="1"\ndeclare -- b\nf\n5\nx\na[b]c a&c\n')
    })
  })

  describe('scripts and descriptors', () => {
    it('runs an executable text file with no shebang as a shell script, with arguments', async () => {
      const r = await run('', "{ printf 'echo \"a $1\"; exit 3\\n' > s.sh; chmod +x s.sh; ./s.sh x; echo rc=$?; printf '\\000\\001bin' > b; chmod +x b; ./b 2>/dev/null; echo rc=$?; }")
      expect(r.out).toBe('a x\nrc=3\nrc=126\n')
    })
    it('read -u reads a descriptor opened with exec, and the last heredoc is the input', async () => {
      const r = await run('', "{ printf 'one\\ntwo\\n' > f; exec 3<f; read -u 3 a; read -u 3 b; echo $a $b; cat <<A <<B\nx\nA\ny\nB\n; }")
      expect(r.out).toBe('one two\ny\n')
    })
    it('${x:?msg} ends a script; a refused assignment does not', async () => {
      const r = await run('', "{ printf 'echo ${zzunset:?missing}\\necho after\\n' > a.sh; printf 'readonly c=1\\nc=2\\necho after\\n' > b.sh; chmod +x a.sh b.sh; ./a.sh 2>/dev/null; echo rc=$?; ./b.sh 2>/dev/null; echo rc=$?; }")
      expect(r.out).toBe('rc=1\nafter\nrc=0\n')
    })
  })

  describe('[[ ]] file tests', () => {
    it('knows the file tests test does: times, sizes, links, special bits, options', async () => {
      const r = await run('touch -d @100 a; touch -d @200 b; echo hi > f; : > g; ln a h; ln -s a l', '{ [[ a -nt b ]]; echo $?; [[ b -nt a ]]; echo $?; [[ -s f ]]; echo $?; [[ -s g ]]; echo $?; [[ a -ef h ]]; echo $?; [[ -L l && -h l ]]; echo $?; [[ -o errexit ]]; echo $?; }')
      expect(r.out).toBe('1\n0\n0\n1\n0\n0\n1\n')
    })
  })

  describe('realpath and readlink', () => {
    const links = 'mkdir d; ln -s d l; ln -s nowhere dang; ln -s l l2; echo > f; ln -s loop2 loop1; ln -s loop1 loop2'
    const at = (r: { dir: string }, text: string) => text.split(r.dir).join('T')

    it('follows symlinks and resolves .. physically', async () => {
      const r = await run(links, 'realpath l l2 l/..')
      expect(at(r, r.out)).toBe('T/d\nT/d\nT\n')
    })
    it('by default only the last component may be missing', async () => {
      const a = await run(links, 'realpath nope')
      expect(at(a, a.out)).toBe('T/nope\n')
      const b = await run(links, 'realpath nope/x')
      expect(b.code).toBe(1)
      expect(b.err).toBe('realpath: nope/x: No such file or directory\n')
      const c = await run(links, 'realpath dang')
      expect(at(c, c.out)).toBe('T/nowhere\n')
    })
    it('-e needs everything and -m nothing', async () => {
      const a = await run(links, 'realpath -e dang')
      expect(a.err).toBe('realpath: dang: No such file or directory\n')
      const b = await run(links, 'realpath -m nope/x/y')
      expect(at(b, b.out)).toBe('T/nope/x/y\n')
    })
    it('reports a file used as a directory and a link loop', async () => {
      expect((await run(links, 'realpath f/x')).err).toBe('realpath: f/x: Not a directory\n')
      expect((await run(links, 'realpath loop1')).err).toBe('realpath: loop1: Too many levels of symbolic links\n')
    })
    it('-s does not expand links, --relative-to makes a relative path', async () => {
      const a = await run(links, 'realpath -s l')
      expect(at(a, a.out)).toBe('T/l\n')
      const b = await run(links, 'realpath --relative-to=d f')
      expect(b.out).toBe('../f\n')
    })
    it('quotes an awkward name in the message', async () => {
      expect((await run('', "realpath -e 'a b'")).err).toBe("realpath: 'a b': No such file or directory\n")
    })
    it('readlink prints a link value and fails quietly for anything else', async () => {
      const a = await run(links, 'readlink l')
      expect(a.out).toBe('d\n')
      const b = await run(links, 'readlink f')
      expect([b.code, b.out, b.err]).toEqual([1, '', ''])
      const c = await run(links, 'readlink -v f')
      expect(c.err).toBe('readlink: f: Invalid argument\n')
    })
    it('readlink -f canonicalizes, -e needs everything', async () => {
      const a = await run(links, 'readlink -f l2')
      expect(at(a, a.out)).toBe('T/d\n')
      const b = await run(links, 'readlink -f nope/x')
      expect([b.code, b.out]).toEqual([1, ''])
      const c = await run(links, 'readlink -e nope')
      expect(c.code).toBe(1)
      const d = await run(links, 'readlink -f d/../l')
      expect(at(d, d.out)).toBe('T/d\n')
    })
  })

  describe('date', () => {
    it('formats a fixed instant in UTC like GNU', async () => {
      expect((await run('', "date -u -d @1700000000")).out).toBe('Tue Nov 14 22:13:20 UTC 2023\n')
      expect((await run('', "date -u -d @1700000000 '+%Y-%m-%d %H:%M:%S %j %U %V'")).out).toBe('2023-11-14 22:13:20 318 46 46\n')
      expect((await run('', "date -u -d @1700000000 -Iseconds")).out).toBe('2023-11-14T22:13:20+00:00\n')
      expect((await run('', "date -u -d @1700000000 -R")).out).toBe('Tue, 14 Nov 2023 22:13:20 +0000\n')
      expect((await run('', "date -u -d @1700000000 --rfc-3339=seconds")).out).toBe('2023-11-14 22:13:20+00:00\n')
    })
    it('reads ISO dates and relative offsets', async () => {
      expect((await run('', "date -u -d '2020-02-29 12:00 UTC' +%s")).out).toBe('1582977600\n')
      expect((await run('', "date -u -d '2020-02-29 UTC + 1 day' +%F")).out).toBe('2020-03-01\n')
    })
    it('rejects bad input', async () => {
      const a = await run('', "date -d bogus")
      expect([a.code, a.err]).toEqual([1, "date: invalid date 'bogus'\n"])
      const b = await run('', 'date a b')
      expect(b.err).toBe("date: extra operand 'b'\nTry 'date --help' for more information.\n")
      const c = await run('', 'date -d')
      expect(c.err).toBe("date: option requires an argument -- 'd'\nTry 'date --help' for more information.\n")
    })
    it('-r prints a file time', async () => {
      const r = await run("echo x > f; touch -d '2001-02-03 04:05:06 UTC' f", 'date -u -r f +%F-%T')
      expect(r.out).toBe('2001-02-03-04:05:06\n')
    })
  })

  describe('stat', () => {
    it('formats fields like GNU', async () => {
      const r = await run("echo hi > f; chmod 640 f; ln -s f l; touch -d '2001-02-03 04:05:06 UTC' f", "stat -c '%n %s %F %a %A %h %Y' f l")
      expect(r.out).toBe('f 3 regular file 640 -rw-r----- 1 981173106\nl 1 symbolic link 777 lrwxrwxrwx 1 ' + r.out.split('\n')[1].split(' ').pop() + '\n')
    })
    it('-L follows a link and %N shows the target', async () => {
      const r = await run('echo hi > f; ln -s f l', "{ stat -Lc %F l; stat -c %N l; }")
      expect(r.out).toBe("regular file\n'l' -> 'f'\n")
    })
    it('--printf interprets escapes and adds no newline', async () => {
      const r = await run('echo hi > f', "stat --printf='%s\\t%n\\n' f")
      expect(r.out).toBe('3\tf\n')
    })
    it('prints the default report', async () => {
      const r = await run("echo hi > f; touch -d '2001-02-03 04:05:06 UTC' f", 'stat f')
      const lines = r.out.split('\n')
      expect(lines[0]).toBe('  File: f')
      expect(lines[1]).toMatch(/^ {2}Size: 3 {9}\tBlocks: \d+ +IO Block: 4096 +regular file$/)
      expect(lines[3]).toMatch(/^Access: \(0644\/-rw-r--r--\)  Uid: \( +\d+\/ +\w+\)   Gid: \( +\d+\/ +\w+\)$/)
    })
    it('names a missing file and continues', async () => {
      const r = await run('echo hi > f', 'stat -c %s nope f')
      expect(r.code).toBe(1)
      expect(r.err).toBe("stat: cannot statx 'nope': No such file or directory\n")
      expect(r.out).toBe('3\n')
    })
    it('needs an operand', async () => {
      expect((await run('', 'stat')).err).toBe("stat: missing operand\nTry 'stat --help' for more information.\n")
    })
  })
})
