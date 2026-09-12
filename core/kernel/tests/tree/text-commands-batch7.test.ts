import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * dd migrated onto real execve. The original had separate `/dev`-path and stdin-stream code paths;
 * both collapse into "read/write real fds with an explicit position" here, since fd 0/1 are real
 * syscall-backed descriptors like any other in a real execve'd process. See dd.mjs's doc comment.
 */
describe('text command batch 7: dd, real execve', () => {
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

  it('dd is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/dd', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('copies if= to of= verbatim', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/dd-in.txt', 'hello world')
    const code = await kernel.shell.execute('dd if=/tmp/dd-in.txt of=/tmp/dd-out.txt status=none')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/dd-out.txt', 'utf-8')).toBe('hello world')
  })

  it('respects bs= block size and count= to copy only N blocks', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/dd-count-in.txt', 'abcdefghij')
    const code = await kernel.shell.execute('dd if=/tmp/dd-count-in.txt of=/tmp/dd-count-out.txt bs=1 count=3 status=none')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/dd-count-out.txt', 'utf-8')).toBe('abc')
  })

  it('respects skip= to skip input blocks', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/dd-skip-in.txt', 'abcdefghij')
    const code = await kernel.shell.execute('dd if=/tmp/dd-skip-in.txt of=/tmp/dd-skip-out.txt bs=1 skip=5 status=none')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/dd-skip-out.txt', 'utf-8')).toBe('fghij')
  })

  it('applies conv=ucase', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/dd-ucase-in.txt', 'hello')
    const code = await kernel.shell.execute('dd if=/tmp/dd-ucase-in.txt of=/tmp/dd-ucase-out.txt conv=ucase status=none')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/dd-ucase-out.txt', 'utf-8')).toBe('HELLO')
  })

  it('reads from stdin and writes to stdout when if=/of= are omitted', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/dd-pipe-in.txt', 'piped data')
    const code = await kernel.shell.execute('cat /tmp/dd-pipe-in.txt | dd status=none > /tmp/dd-pipe-out.txt')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/dd-pipe-out.txt', 'utf-8')).toBe('piped data')
  })

  it('prints transfer statistics to stderr unless status=none', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/dd-status-in.txt', 'stats test')
    const code = await kernel.shell.execute('dd if=/tmp/dd-status-in.txt of=/tmp/dd-status-out.txt 2>/tmp/dd-status.err')
    expect(code).toBe(0)
    const err = await kernel.filesystem.fs.readFile('/tmp/dd-status.err', 'utf-8')
    expect(err).toContain('bytes copied')
  })

  it('errors on a missing input file', async () => {
    const code = await kernel.shell.execute('dd if=/tmp/dd-does-not-exist.txt of=/tmp/dd-missing-out.txt 2>/tmp/dd-missing.err')
    expect(code).toBe(1)
  })
})
