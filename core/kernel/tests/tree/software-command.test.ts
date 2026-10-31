import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('the software command', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/sw.out 2> /tmp/sw.err`)
    return { code, out: await fs().readFile('/tmp/sw.out', 'utf8'), err: await fs().readFile('/tmp/sw.err', 'utf8') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_ALL, profile: 'everything' })
    await kernel.boot()
    await kernel.whenProgramsReady()
  }, 180_000)

  it('lists the collections by category with how many of each are installed', async () => {
    const result = await run('software list')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toMatch(/^Development\n\s+dev\s+\d+\/\d+ installed/m)
    expect(result.out).toMatch(/^System$/m)
    const json = JSON.parse((await run('software list --json')).out)
    const editors = json.categories.flatMap((category: { collections: { name: string }[] }) => category.collections).find((collection: { name: string }) => collection.name === 'editors')
    expect(editors.members.map((member: { name: string }) => member.name)).toEqual(['vim'])
    expect(editors.members[0].installed).toBe(true)
  }, 60_000)

  it('lists the members of a collection, marking what is installed', async () => {
    const result = await run('software list compression')
    expect(result.out).toMatch(/\* bzip2/)
    expect((await run('software list nothing')).code).toBe(1)
  }, 60_000)

  it('searches the index by name and description, and folds in the registry only when asked', async () => {
    const result = await run('software search editor')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toMatch(/vim/)
    expect(result.out).not.toContain('More on npm')
    const none = await run('software search zzzznothing')
    expect(none.code).toBe(1)
    expect(none.out).toContain('--npm')
    const npm = await run('software search --npm --registry http://127.0.0.1:1 zzzznothing')
    expect(npm.out).toContain('More on npm (not curated')
    expect(npm.out).toContain('the registry did not answer')
  }, 60_000)

  it('shows a program from the index without the registry: size, license, source and who it is for', async () => {
    const result = await run('software show vim --offline')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('@ecmaos-apps/vim')
    expect(result.out).toMatch(/License:\s+Vim/)
    expect(result.out).toContain('apt source vim')
    expect(result.out).toContain('everyone only')
    expect(result.out).toMatch(/Collections:\s+editors/)
    const json = JSON.parse((await run('software show vim --offline --json')).out)
    expect(json.kind).toBe('wasm')
    expect(json.installed.version).toMatch(/^9\./)
    expect((await run('software show no-such-thing-here --offline')).code).toBe(1)
  }, 60_000)

  it('lists what is installed split into asked for, collections and dependencies', async () => {
    const result = await run('software installed')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toMatch(/^Asked for by name \(\d+\)$/m)
    expect(result.out).toMatch(/^Installed as dependencies \(\d+\)$/m)
    const json = JSON.parse((await run('software installed --json')).out)
    expect(json.installed.some((row: { name: string }) => row.name.startsWith('@ecmaos-apps/'))).toBe(true)
  }, 60_000)

  it('says how to get the window when it is not installed', async () => {
    const result = await run('software gui')
    expect(result.code).toBe(1)
    expect(result.err).toContain('@ecmaos-apps/software')
  }, 60_000)
})
