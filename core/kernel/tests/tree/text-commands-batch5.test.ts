import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * split, pr, tee and stat as `execve` programs. `tee`
 * expands `~` from `env.HOME`.
 */
describe('text command batch 5: split/pr/tee/stat, real execve', () => {
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

  for (const name of ['split', 'pr', 'tee', 'stat']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('split splits a file into pieces by line count', async () => {
    // Pieces are written next to the working directory, as GNU `split` does, not next to the input file.
    await kernel.filesystem.fs.mkdir('/tmp/split-test', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/split-test/input.txt', 'a\nb\nc\nd\n')
    const code = await kernel.shell.execute('cd /tmp/split-test; split -l2 input.txt out.')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/split-test/out.aa', 'utf-8')).toBe('a\nb\n')
    expect(await kernel.filesystem.fs.readFile('/tmp/split-test/out.ab', 'utf-8')).toBe('c\nd\n')
  })

  it('pr paginates a file with a page header', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/pr-in.txt', 'line1\nline2\n')
    const code = await kernel.shell.execute('pr -l 12 /tmp/pr-in.txt > /tmp/pr.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/pr.out', 'utf-8')
    expect(out).toContain('line1')
    expect(out).toContain('Page 1')
  })

  it('tee writes to stdout and to a real file simultaneously', async () => {
    const code = await kernel.shell.execute('echo hello | tee /tmp/tee.out > /tmp/tee-stdout.out')
    expect(code).toBe(0)
    expect((await kernel.filesystem.fs.readFile('/tmp/tee.out', 'utf-8')).trim()).toBe('hello')
    expect((await kernel.filesystem.fs.readFile('/tmp/tee-stdout.out', 'utf-8')).trim()).toBe('hello')
  })

  it('tee -a appends instead of overwriting', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/tee-append.out', 'existing\n')
    const code = await kernel.shell.execute('echo appended | tee -a /tmp/tee-append.out > /dev/null')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/tee-append.out', 'utf-8')
    expect(out).toBe('existing\nappended\n')
  })

  it('stat prints the GNU report and honours -c', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/stat-in.txt', 'hello')
    expect(await kernel.shell.execute('stat -c "%n %s %F" /tmp/stat-in.txt > /tmp/stat.out')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/stat.out', 'utf-8')).toBe('/tmp/stat-in.txt 5 regular file\n')
    expect(await kernel.shell.execute('stat /tmp/stat-in.txt > /tmp/stat.out')).toBe(0)
    const report = (await kernel.filesystem.fs.readFile('/tmp/stat.out', 'utf-8')) as string
    expect(report).toContain('  File: /tmp/stat-in.txt\n  Size: 5')
    expect(report).toMatch(/Access: \(0\d{3}\/-[rwx-]{9}\)/)
  })

  it('stat reports an error and nonzero exit for a missing file', async () => {
    const code = await kernel.shell.execute('stat /tmp/does-not-exist-batch5.txt 2>/tmp/stat-missing.err')
    expect(code).toBe(1)
  })

  it('split and pr report an error and nonzero exit for a missing file', async () => {
    const code1 = await kernel.shell.execute('split -l 1 /tmp/does-not-exist-batch5.txt 2>/tmp/split-missing.err')
    expect(code1).toBe(1)
  }, 20000)
})
