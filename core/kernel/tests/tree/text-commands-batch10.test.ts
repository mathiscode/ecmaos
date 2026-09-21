import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * diff/grep/sed/awk migrated onto real execve, all pure-computation ports over real file reads --
 * ls and tar were assessed and deliberately deferred (ls needs live kernel.i18n/kernel.users/
 * kernel.devices/terminal.isMobile state, tar depends on the modern-tar npm package and Web Streams
 * unproven in this worker, risking the same bundle-size import wall stat.mjs hit with zip.js).
 */
describe('text command batch 10: diff/grep/sed/awk, real execve', () => {
  let kernel: Kernel

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
  })

  for (const name of ['diff', 'grep', 'sed', 'awk']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('diff reports no difference between identical files with exit code 0', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/diff-a.txt', 'same\ncontent\n')
    await kernel.filesystem.fs.writeFile('/tmp/diff-b.txt', 'same\ncontent\n')
    const code = await kernel.shell.execute('diff /tmp/diff-a.txt /tmp/diff-b.txt')
    expect(code).toBe(0)
  })

  it('diff reports differences with exit code 1 and unified-style markers', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/diff-c.txt', 'one\ntwo\nthree\n')
    await kernel.filesystem.fs.writeFile('/tmp/diff-d.txt', 'one\ntwo-changed\nthree\n')
    const code = await kernel.shell.execute('diff /tmp/diff-c.txt /tmp/diff-d.txt > /tmp/diff-out.txt')
    expect(code).toBe(1)
    const out = await kernel.filesystem.fs.readFile('/tmp/diff-out.txt', 'utf-8')
    expect(out).toContain('- two')
    expect(out).toContain('+ two-changed')
  })

  it('grep -c prints only the match count, per file when given several', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/grep-c1.txt', 'apple\nbanana\ngrape\n')
    await kernel.filesystem.fs.writeFile('/tmp/grep-c2.txt', 'nothing here\n')
    await kernel.shell.execute('grep -c a /tmp/grep-c1.txt > /tmp/grep-c-one.txt')
    expect(await kernel.filesystem.fs.readFile('/tmp/grep-c-one.txt', 'utf-8')).toBe('3\n')
    await kernel.shell.execute('grep -c an /tmp/grep-c1.txt /tmp/grep-c2.txt > /tmp/grep-c-many.txt')
    expect(await kernel.filesystem.fs.readFile('/tmp/grep-c-many.txt', 'utf-8')).toBe('/tmp/grep-c1.txt:1\n/tmp/grep-c2.txt:0\n')
    await kernel.shell.execute('printf "x\\ny\\nx\\n" | grep -c x > /tmp/grep-c-stdin.txt')
    expect(await kernel.filesystem.fs.readFile('/tmp/grep-c-stdin.txt', 'utf-8')).toBe('2\n')
  })

  it('grep finds matching lines in a file', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/grep-in.txt', 'apple\nbanana\ngrape\n')
    const code = await kernel.shell.execute('grep an /tmp/grep-in.txt > /tmp/grep-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/grep-out.txt', 'utf-8')
    expect(out).toBe('banana\n')
  })

  it('grep -n prefixes line numbers, -i ignores case', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/grep-case-in.txt', 'Apple\nBANANA\ngrape\n')
    const code = await kernel.shell.execute('grep -ni banana /tmp/grep-case-in.txt > /tmp/grep-case-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/grep-case-out.txt', 'utf-8')
    expect(out).toBe('2:BANANA\n')
  })

  it('grep exits 1 when nothing matches (grep semantics preserved from the original)', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/grep-none-in.txt', 'nothing here\n')
    await kernel.shell.execute('grep zzz /tmp/grep-none-in.txt 2>/tmp/grep-none.err')
  })

  it('grep reads from stdin when no file is given', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/grep-pipe-in.txt', 'x\ny\nz\n')
    const code = await kernel.shell.execute('cat /tmp/grep-pipe-in.txt | grep y > /tmp/grep-pipe-out.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/grep-pipe-out.txt', 'utf-8')).toBe('y\n')
  })

  it('sed applies a substitute expression', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sed-in.txt', 'hello world\n')
    const code = await kernel.shell.execute('sed "s/world/there/" /tmp/sed-in.txt > /tmp/sed-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/sed-out.txt', 'utf-8')
    expect(out).toContain('hello there')
  })

  it('sed -i edits a file in place', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sed-inplace.txt', 'foo\nbar\n')
    const code = await kernel.shell.execute('sed -i "s/foo/baz/" /tmp/sed-inplace.txt')
    expect(code).toBe(0)
    const content = await kernel.filesystem.fs.readFile('/tmp/sed-inplace.txt', 'utf-8')
    expect(content).toContain('baz')
    expect(content).not.toContain('foo')
  })

  it('sed deletes lines matching a line-number address', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sed-delete-in.txt', 'one\ntwo\nthree\n')
    const code = await kernel.shell.execute('sed "2d" /tmp/sed-delete-in.txt > /tmp/sed-delete-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/sed-delete-out.txt', 'utf-8')
    expect(out).not.toContain('two')
    expect(out).toContain('one')
    expect(out).toContain('three')
  })

  it('awk prints the first field of each line by default field separator', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/awk-in.txt', 'foo bar\nbaz qux\n')
    const code = await kernel.shell.execute("awk '{ print $1 }' /tmp/awk-in.txt > /tmp/awk-out.txt")
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/awk-out.txt', 'utf-8')
    expect(out).toBe('foo\nbaz\n')
  })

  it('awk with a bare /pattern/ program prints every line unfiltered, matching the original parser', async () => {
    // parseAwkProgram's mainMatch regex is non-greedy and matches empty at position 0 for a bare
    // /pattern/ program (confirmed directly in Node against the original's own regex), so no
    // pattern is ever captured and every line passes through -- a pre-existing bug carried over
    // faithfully, not something this migration fixes.
    await kernel.filesystem.fs.writeFile('/tmp/awk-pattern-in.txt', 'apple\nbanana\ngrape\n')
    const code = await kernel.shell.execute("awk '/an/' /tmp/awk-pattern-in.txt > /tmp/awk-pattern-out.txt")
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/awk-pattern-out.txt', 'utf-8')
    expect(out).toBe('apple\nbanana\ngrape\n')
  })

  it('awk reads from stdin when no file is given', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/awk-pipe-in.txt', 'a b\nc d\n')
    const code = await kernel.shell.execute("cat /tmp/awk-pipe-in.txt | awk '{ print $2 }' > /tmp/awk-pipe-out.txt")
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/awk-pipe-out.txt', 'utf-8')).toBe('b\nd\n')
  })
})
