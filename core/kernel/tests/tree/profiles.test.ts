import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { DEFAULT_PROFILE, PROFILE_FILE, inProfile, readProfile, resolveProfile, writeProfile } from '#lib/profiles.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const memory = () => {
  const files = new Map<string, string>()
  return {
    files,
    fs: {
      readFile: async (path: string) => { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path)! },
      writeFile: async (path: string, data: string) => { files.set(path, data) },
      mkdir: async () => undefined,
      exists: async (path: string) => files.has(path)
    } as unknown as Parameters<typeof resolveProfile>[0]
  }
}

describe('profile choice', () => {
  it('a profile holds what the smaller ones do, and a program with no tier is in all of them', () => {
    expect(inProfile('minimal', 'minimal')).toBe(true)
    expect(inProfile('standard', 'minimal')).toBe(false)
    expect(inProfile('standard', 'developer')).toBe(true)
    expect(inProfile('everything', 'everything')).toBe(true)
    expect(inProfile(undefined, 'minimal')).toBe(true)
    expect(inProfile('nonsense', 'minimal')).toBe(true)
  })

  it('a request wins and is not recorded', async () => {
    const { fs, files } = memory()
    expect(await resolveProfile(fs, { requested: 'minimal', hasPrograms: true })).toEqual({ profile: 'minimal', recorded: false })
    expect(files.size).toBe(0)
  })

  it('the recorded profile is used; an unknown request is ignored', async () => {
    const { fs } = memory()
    await writeProfile(fs, 'developer')
    expect(await readProfile(fs)).toBe('developer')
    expect((await resolveProfile(fs, { requested: 'huge', hasPrograms: false })).profile).toBe('developer')
  })

  it('a machine that has programs and no record becomes Everything and is recorded', async () => {
    const { fs, files } = memory()
    expect((await resolveProfile(fs, { hasPrograms: true })).profile).toBe('everything')
    expect(files.get(PROFILE_FILE)).toBe('everything\n')
  })

  it('a fresh machine asks a person if there is one, and is Standard if nobody answers', async () => {
    const asked = memory()
    expect((await resolveProfile(asked.fs, { hasPrograms: false, ask: async () => 'developer' })).profile).toBe('developer')
    expect(asked.files.get(PROFILE_FILE)).toBe('developer\n')
    const unanswered = memory()
    expect((await resolveProfile(unanswered.fs, { hasPrograms: false, ask: async () => undefined })).profile).toBe(DEFAULT_PROFILE)
    expect((await resolveProfile(memory().fs, { hasPrograms: false })).profile).toBe('standard')
  })
})

describe('the profile at boot', () => {
  const boot = async (options: { profile?: 'minimal' | 'standard' | 'developer' | 'everything' }) => {
    const kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_ALL, ...options })
    await kernel.boot()
    await kernel.whenProgramsReady()
    return kernel
  }
  const present = async (kernel: Kernel, name: string) => (await kernel.filesystem.fs.exists(`/bin/${name}`)) && !(await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf8').then(text => text.startsWith('#!/usr/libexec'), () => true))

  let minimal: Kernel
  beforeAll(async () => { minimal = await boot({ profile: 'minimal' }) }, 120_000)

  it('installs only the programs of the profile asked for, and does not record a request', async () => {
    expect(await present(minimal, 'bzip2')).toBe(true)
    expect(await minimal.filesystem.fs.exists('/bin/bash')).toBe(true)
    expect(await minimal.filesystem.fs.exists('/bin/vim')).toBe(false)
    expect(await minimal.filesystem.fs.exists('/bin/python3')).toBe(false)
    expect(await minimal.filesystem.fs.exists(PROFILE_FILE)).toBe(false)
  }, 60_000)
  it('records the profile in the install database: seeded programs, groups and the profile as the one explicit package', async () => {
    const db = JSON.parse(await minimal.filesystem.fs.readFile('/var/lib/install/db.json', 'utf8')).packages as Record<string, { explicit: boolean, seeded?: boolean, file?: string, dependencies: Record<string, string> }>
    const profile = db['@ecmaos-apps/profile-minimal@1.0.0']!
    expect(profile.explicit).toBe(true)
    expect(Object.keys(profile.dependencies)).toEqual(expect.arrayContaining(['@ecmaos-apps/bash', '@ecmaos-apps/group-compression']))
    const compression = db['@ecmaos-apps/group-compression@1.0.0']!
    expect(compression.explicit).toBe(false)
    expect(Object.keys(compression.dependencies)).toEqual(expect.arrayContaining(['@ecmaos-apps/bzip2', '@ecmaos-apps/xz']))
    const bzip2 = Object.entries(db).find(([key]) => key.startsWith('@ecmaos-apps/bzip2@'))![1]
    expect(bzip2).toMatchObject({ seeded: true, explicit: false, file: '/bin/bzip2' })
    expect(Object.keys(db).some(key => key.startsWith('@ecmaos-apps/vim@'))).toBe(false)
    expect(JSON.parse(await minimal.filesystem.fs.readFile('/usr/lib/@ecmaos-apps/group-compression/1.0.0/package.json', 'utf8')).ecmaos.meta).toBe(true)
  }, 60_000)

  it('install lists them, remove deletes the file and keeps it out of the next boot, and a group stays installed', async () => {
    const fs = minimal.filesystem.fs
    const run = async (command: string) => {
      const code = await minimal.shell.execute(`${command} > /tmp/p.out 2> /tmp/p.err`)
      return { code, out: await fs.readFile('/tmp/p.out', 'utf8'), err: await fs.readFile('/tmp/p.err', 'utf8') }
    }
    expect((await run('install list --all')).out).toMatch(/@ecmaos-apps\/xz@.* \[dependency\]/)
    expect((await run('install remove @ecmaos-apps/xz')).code).toBe(0)
    expect(await fs.exists('/bin/xz')).toBe(false)
    expect(JSON.parse(await fs.readFile('/etc/ecmaos/profile.d/excluded.json', 'utf8'))).toContain('@ecmaos-apps/xz')
    expect(await fs.exists('/usr/lib/@ecmaos-apps/group-compression/1.0.0/package.json')).toBe(true)
    expect(await fs.exists('/bin/zstd')).toBe(true)
  }, 60_000)
})
