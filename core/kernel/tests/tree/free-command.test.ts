import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `free` (`core/utils/src/commands-execve/free.mjs`) reads the already-populated `/proc/meminfo`
 * and reports it in `free`'s traditional column layout. jsdom doesn't implement
 * `navigator.deviceMemory`/`performance.memory`, so `/proc/meminfo` is typically empty here --
 * this asserts the command runs cleanly and produces the expected shape either way, not specific
 * numbers no test environment can promise.
 */
describe('free', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  it('is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/free', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('runs cleanly and prints a header row with total/used/free/available', async () => {
    const code = await kernel.shell.execute('free > /tmp/free-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/free-out.txt', 'utf-8')
    expect(out).toContain('total')
    expect(out).toContain('used')
    expect(out).toContain('free')
    expect(out).toContain('available')
    expect(out).toContain('Mem:')
  })

  it('accepts -h without erroring', async () => {
    const code = await kernel.shell.execute('free -h > /tmp/free-h-out.txt')
    expect(code).toBe(0)
  })

  it('accepts -m without erroring', async () => {
    const code = await kernel.shell.execute('free -m > /tmp/free-m-out.txt')
    expect(code).toBe(0)
  })

  it('--help prints usage to stderr and exits 0', async () => {
    const code = await kernel.shell.execute('free --help 2>/tmp/free-help-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/free-help-out.txt', 'utf-8')
    expect(out).toContain('Usage: free')
  })
})
