import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `ls` as a real execve program. Its formatting is unit-tested in `@ecmaos/coreutils`
 * (`ls-format.test.ts`); these run the program against a real filesystem.
 */
describe('ls, real execve', () => {
  let kernel: Kernel
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/ls-out.txt 2> /tmp/ls-err.txt`)
    const read = (name: string) => kernel.filesystem.fs.readFile(`/tmp/${name}`, 'utf-8')
    return { code, out: await read('ls-out.txt'), err: await read('ls-err.txt') }
  }

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()

    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)

    const fs = kernel.filesystem.fs
    await fs.mkdir('/tmp/ls-root/subdir/deep', { recursive: true })
    await fs.writeFile('/tmp/ls-root/a.txt', 'hello')
    await fs.writeFile('/tmp/ls-root/b.txt', 'world!!')
    await fs.writeFile('/tmp/ls-root/.hidden', 'x')
    await fs.writeFile('/tmp/ls-root/subdir/inner.txt', 'in')
    await fs.writeFile('/tmp/ls-root/subdir/deep/bottom.txt', 'bottom')
    await fs.writeFile('/tmp/ls-root/run.sh', '#!/bin/sh\n', { mode: 0o755 })
  })

  // a test that fails before its own cleanup must not change what the next one lists
  afterEach(async () => {
    for (const name of ['big.bin', 'mylink', 'dirlink']) await kernel.filesystem.fs.unlink(`/tmp/ls-root/${name}`).catch(() => {})
  })

  it('ls is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/ls', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('prints names one per line when output is not a terminal, sorted, hiding dotfiles', async () => {
    const { code, out } = await run('ls /tmp/ls-root')
    expect(code).toBe(0)
    expect(out).toBe('a.txt\nb.txt\nrun.sh\nsubdir\n')
  })

  it('-a adds dotfiles and . and .., -A leaves out . and ..', async () => {
    expect((await run('ls -a /tmp/ls-root')).out).toBe('.\n..\n.hidden\na.txt\nb.txt\nrun.sh\nsubdir\n')
    expect((await run('ls -A /tmp/ls-root')).out).toBe('.hidden\na.txt\nb.txt\nrun.sh\nsubdir\n')
  })

  it('-l shows type and mode, link count, owner and group names, size, date and name', async () => {
    const { code, out } = await run('ls -l /tmp/ls-root')
    expect(code).toBe(0)
    const lines = out.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^total \d+$/)
    expect(lines[1]).toMatch(/^-rw-r--r-- +1 root +root +5 \w{3} [ \d]\d [\d:]{5} a\.txt$/)
    expect(lines[3]).toMatch(/^-rwxr-xr-x +1 root +root +\d+ .* run\.sh$/)
    expect(lines[4]).toMatch(/^drwx[r-][w-][x-]r.x +\d+ root +root +\d+ .* subdir$/)
  })

  it('-lh prints human sizes and -h alone is not help', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/ls-root/big.bin', new Uint8Array(1536))
    const { code, out } = await run('ls -lh /tmp/ls-root/big.bin')
    expect(code).toBe(0)
    expect(out).toMatch(/ root +root +1\.5K .* \/tmp\/ls-root\/big\.bin\n$/)
    await kernel.filesystem.fs.unlink('/tmp/ls-root/big.bin')
  })

  it('-d lists a directory itself, not its contents', async () => {
    expect((await run('ls -d /tmp/ls-root')).out).toBe('/tmp/ls-root\n')
    expect((await run('ls -ld /tmp/ls-root')).out).toMatch(/^drwx.* \/tmp\/ls-root\n$/)
  })

  it('-F marks directories, executables and links; -p only directories', async () => {
    await kernel.shell.execute('ln -s /tmp/ls-root/a.txt /tmp/ls-root/mylink')
    expect((await run('ls -F /tmp/ls-root')).out).toBe('a.txt\nb.txt\nmylink@\nrun.sh*\nsubdir/\n')
    expect((await run('ls -p /tmp/ls-root')).out).toBe('a.txt\nb.txt\nmylink\nrun.sh\nsubdir/\n')
    await kernel.filesystem.fs.unlink('/tmp/ls-root/mylink')
  })

  it('-R lists subdirectories with headers, blank line between', async () => {
    const { out } = await run('ls -R /tmp/ls-root/subdir')
    expect(out).toBe('/tmp/ls-root/subdir:\ndeep\ninner.txt\n\n/tmp/ls-root/subdir/deep:\nbottom.txt\n')
  })

  it('sorts with -r, -S and -t', async () => {
    expect((await run('ls -r /tmp/ls-root')).out).toBe('subdir\nrun.sh\nb.txt\na.txt\n')
    const bySize = (await run('ls -S /tmp/ls-root')).out.split('\n')
    expect(bySize.indexOf('b.txt')).toBeLessThan(bySize.indexOf('a.txt'))
    await kernel.filesystem.fs.utimes('/tmp/ls-root/a.txt', new Date(2030, 0, 1), new Date(2030, 0, 1))
    expect((await run('ls -t /tmp/ls-root')).out.split('\n')[0]).toBe('a.txt')
  })

  it('lists several operands with headers: files first, then each directory', async () => {
    const { out } = await run('ls /tmp/ls-root/a.txt /tmp/ls-root/subdir /tmp/ls-root/b.txt')
    expect(out).toBe('/tmp/ls-root/a.txt\n/tmp/ls-root/b.txt\n\n/tmp/ls-root/subdir:\ndeep\ninner.txt\n')
  })

  it('lists a single file operand as itself', async () => {
    const { code, out } = await run('ls /tmp/ls-root/a.txt')
    expect(code).toBe(0)
    expect(out).toBe('/tmp/ls-root/a.txt\n')
  })

  it('defaults to the current directory', async () => {
    expect((await run('cd /tmp/ls-root && ls')).out).toBe('a.txt\nb.txt\nrun.sh\nsubdir\n')
  })

  it('shows a symlink with its target in the long format, and follows a link to a directory otherwise', async () => {
    await kernel.shell.execute('ln -s /tmp/ls-root/a.txt /tmp/ls-root/mylink')
    await kernel.shell.execute('ln -s /tmp/ls-root/subdir /tmp/ls-root/dirlink')
    expect((await run('ls -l /tmp/ls-root')).out).toMatch(/lrwxrwxrwx .* mylink -> \/tmp\/ls-root\/a\.txt\n/)
    expect((await run('ls /tmp/ls-root/dirlink')).out).toBe('deep\ninner.txt\n')
    expect((await run('ls -l /tmp/ls-root/dirlink')).out).toMatch(/^lrwxrwxrwx .* \/tmp\/ls-root\/dirlink -> \/tmp\/ls-root\/subdir\n$/)
    await kernel.filesystem.fs.unlink('/tmp/ls-root/mylink')
    await kernel.filesystem.fs.unlink('/tmp/ls-root/dirlink')
  })

  it('shows device numbers for device nodes', async () => {
    expect((await run('ls -l /dev/null')).out).toMatch(/^crw-rw-rw- +1 root +root +1, 3 .* \/dev\/null\n$/)
  })

  it('reports a nonexistent operand on stderr, exits 2, and still lists the others', async () => {
    const { code, out, err } = await run('ls /tmp/ls-does-not-exist /tmp/ls-root/a.txt')
    expect(code).toBe(2)
    expect(err).toBe("ls: cannot access '/tmp/ls-does-not-exist': No such file or directory\n")
    expect(out).toBe('/tmp/ls-root/a.txt\n')
  })

  it('rejects an unknown option and answers --help', async () => {
    const bad = await run('ls -Z')
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("invalid option -- 'Z'")
    const help = await run('ls --help')
    expect(help.code).toBe(0)
    expect(help.out).toContain('Usage: ls')
  })
})
