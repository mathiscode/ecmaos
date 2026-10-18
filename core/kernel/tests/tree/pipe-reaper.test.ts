import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { processes } from '@zenfs/linux'
import { pipefs } from '@zenfs/linux/fs/pipe'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { reapPipes } from '#lib/pipe-reaper.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const pipeCount = () => (pipefs as unknown as { pipes: Map<number, unknown> }).pipes.size

describe('pipes that nothing refers to are freed', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  }, 60000)

  afterAll(async () => { await kernel.shutdown() })

  it('does not keep the pipes of finished pipelines', async () => {
    for (let i = 0; i < 40; i++) await kernel.shell.execute('echo a | cat | cat > /dev/null')
    reapPipes()
    reapPipes()
    // what is left belongs to the system's own processes, not to the 40 pipelines (about a dozen pipes each before this)
    expect(pipeCount()).toBeLessThan(60)
  }, 120000)

  it('runs every stage of a pipeline of the same program and leaves no process behind', async () => {
    const before = new Set(processes.keys())
    for (let i = 0; i < 10; i++) expect(await kernel.shell.execute('echo a | cat | cat > /tmp/same')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/same', 'utf8')).toBe('a\n')
    expect([...processes].filter(([pid, proc]) => !before.has(pid) && proc.code === undefined && proc.exe === undefined)).toEqual([])
  }, 60000)

  it('leaves a pipe alone while a process still holds it', async () => {
    const running = kernel.shell.execute('sleep 1 | cat')
    await new Promise(resolve => setTimeout(resolve, 300))
    reapPipes()
    reapPipes()
    expect(await running).toBe(0)
  }, 60000)

  it('still pipes data correctly after sweeps', async () => {
    for (let i = 0; i < 70; i++) {
      await kernel.shell.execute(`printf 'x%s\\n' ${i} | cat > /tmp/pr-${i % 3}`)
    }
    const text = await kernel.filesystem.fs.readFile('/tmp/pr-0', 'utf8')
    expect(text).toBe('x69\n')
  }, 120000)
})
