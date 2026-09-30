import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { appendText } from '#lib/append-file.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `appendFile` on the root filesystem writes each chunk at offset 0 of the file it just grew, leaving
 * NUL bytes where the earlier records were. These run against the real kernel filesystem, since the
 * in-memory fakes the unit tests use do not have the bug.
 */
describe('appending on the root filesystem', () => {
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

  const fs = () => kernel.filesystem.fs

  it('>> keeps every earlier line', async () => {
    await kernel.shell.execute('echo one >> /root/append-a; echo two >> /root/append-a; echo three >> /root/append-a')
    expect(await fs().readFile('/root/append-a', 'utf-8')).toBe('one\ntwo\nthree\n')
  })

  it('> writes output that arrives in several chunks', async () => {
    await kernel.shell.execute('seq 1 3000 > /root/append-b')
    const lines = (await fs().readFile('/root/append-b', 'utf-8')).trim().split('\n')
    expect(lines).toHaveLength(3000)
    expect(lines[2999]).toBe('3000')
  })

  it('appendText keeps records and serializes concurrent callers', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map(x => appendText(fs(), '/root/append-c', `${x}\n`)))
    expect((await fs().readFile('/root/append-c', 'utf-8')).split('\n').filter(Boolean).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('shell history survives more than one command on disk', async () => {
    const terminal = kernel.terminal as unknown as { clearHistory(): Promise<void> }
    await terminal.clearHistory()
    const history = (kernel.terminal as unknown as { _history: { add(uid: number, cmd: string): Promise<boolean> } })._history
    await history.add(0, 'first')
    await history.add(0, 'second')
    await history.add(0, 'third')
    expect(await fs().readFile('/root/.ecmash_history', 'utf-8')).toBe('first\nsecond\nthird\n')
  })

  it('load heals a history file already damaged by the bug', async () => {
    await fs().writeFile('/root/.ecmash_history', 'kept\n\0\0\0\0\0\0\0\0')
    const terminal = kernel.terminal as unknown as { reloadHistory(uid: number): Promise<void> }
    await terminal.reloadHistory(0)
    const history = (kernel.terminal as unknown as { _history: { entries(uid: number): string[] } })._history
    expect(history.entries(0)).toEqual(['kept'])
  })
})
