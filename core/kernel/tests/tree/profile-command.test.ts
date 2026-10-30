import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { PROFILE_FILE, writeProfile } from '#lib/profiles.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('the profile command', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/pc.out 2> /tmp/pc.err`)
    return { code, out: await fs().readFile('/tmp/pc.out', 'utf8'), err: await fs().readFile('/tmp/pc.err', 'utf8') }
  }
  const packages = async () => JSON.parse(await fs().readFile('/var/lib/install/db.json', 'utf8')).packages as Record<string, { explicit: boolean }>

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_ALL, profile: 'everything' })
    await kernel.boot()
    await kernel.whenProgramsReady()
    await writeProfile(fs() as never, 'everything')
  }, 180_000)

  it('lists the profiles and shows the current one', async () => {
    expect((await run('profile list')).out).toMatch(/\* everything\s/)
    expect((await run('profile')).out).toBe('everything\n')
  }, 30_000)

  it('going down shows the plan, removes only what the bigger profile brought, and keeps it out of the next boot', async () => {
    expect(await fs().exists('/bin/vim')).toBe(true)
    const declined = await kernel.shell.execute('echo n | profile set minimal > /tmp/pc.out 2>&1')
    expect(declined).toBe(1)
    expect(await fs().readFile('/tmp/pc.out', 'utf8')).toContain('@ecmaos-apps/vim@')
    expect(await fs().exists('/bin/vim')).toBe(true)

    const result = await run('profile set -y minimal')
    expect(result.code, result.err).toBe(0)
    expect(await fs().exists('/bin/vim')).toBe(false)
    expect(await fs().exists('/bin/bzip2')).toBe(true)
    expect(await fs().readFile(PROFILE_FILE, 'utf8')).toBe('minimal\n')
    const db = await packages()
    expect(db['@ecmaos-apps/profile-minimal@1.0.0']?.explicit).toBe(true)
    expect(Object.keys(db).some(key => key.startsWith('@ecmaos-apps/profile-everything@'))).toBe(false)
    expect(Object.keys(db).some(key => key.startsWith('@ecmaos-apps/vim@'))).toBe(false)
    expect(JSON.parse(await fs().readFile('/etc/ecmaos/profile.d/excluded.json', 'utf8'))).toContain('@ecmaos-apps/vim')
  }, 120_000)

  it('going up records the choice and clears what the bigger profile brings from the list of what is kept out', async () => {
    const result = await run('profile set -y --offline standard')
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('added at the next boot')
    expect(await fs().readFile(PROFILE_FILE, 'utf8')).toBe('standard\n')
    expect(JSON.parse(await fs().readFile('/etc/ecmaos/profile.d/excluded.json', 'utf8'))).not.toContain('@ecmaos-apps/vim')
  }, 60_000)

  it('refuses a profile that does not exist', async () => {
    const result = await run('profile set -y huge')
    expect(result.code).toBe(1)
    expect(result.err).toContain('no profile named huge')
  }, 30_000)
})
