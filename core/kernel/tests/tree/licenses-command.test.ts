import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

// The real filesystem: `node:fs` is the machine's own inside a test
const { readdirSync, readFileSync } = process.getBuiltinModule('node:fs')

/** `licenses` (a command of `@ecmaos/coreutils`) reads the notices the initfs keeps in `/usr/share/licenses` */
describe('licenses', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()

    // the initfs is not unpacked in a test: put the notices it would hold where the machine has them
    const source = `${process.cwd()}/public/initfs/usr/share/licenses`
    const copy = async (dir: string) => {
      await kernel.filesystem.fs.mkdir(`/usr/share/licenses/${dir}`, { recursive: true })
      for (const entry of readdirSync(`${source}/${dir}`, { withFileTypes: true })) {
        const name = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) await copy(name)
        else await kernel.filesystem.fs.writeFile(`/usr/share/licenses/${name}`, readFileSync(`${source}/${name}`, 'utf8'))
      }
    }
    await copy('')
  }, 120000)

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/lic.out 2> /tmp/lic.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/lic.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/lic.err', 'utf8') }
  }

  it('lists ecmaOS, every LGPL library the build bundles and the programs, each with its license', async () => {
    const { code, out } = await run('licenses')
    expect(code).toBe(0)
    expect(out).toMatch(/^ +ecmaos +MIT OR Apache-2\.0/m)
    for (const library of ['@zenfs/core', '@zenfs/linux', '@zenfs/streams', 'utilium', 'memium']) expect(out).toMatch(new RegExp(`^ +${library} +LGPL-3\\.0-or-later`, 'm'))
    expect(out).toMatch(/^ +bash +GPL-3\.0-or-later +/m)
    expect(out).toMatch(/^ +nano +GPL-3\.0-or-later AND X11/m)
    expect(out).toMatch(/^ +jq +permissive/m)
  }, 60000)

  it('prints the texts kept for a library, with its copyright and the LGPL, and the source offer of a copyleft program', async () => {
    const library = await run('licenses utilium')
    expect(library.code).toBe(0)
    expect(library.out).toContain('==> /usr/share/licenses/utilium/COPYRIGHT.txt <==')
    expect(library.out).toContain('GNU LESSER GENERAL PUBLIC LICENSE')
    expect((await run('licenses zenfs/core')).out).toContain('Exception for web applications')
    const program = await run('licenses bash')
    expect(program.out).toContain('Where to get it')
  }, 60000)

  it('refuses a name nothing is kept for, and an option it does not have', async () => {
    expect(await run('licenses nothing-by-this-name')).toMatchObject({ code: 1, err: expect.stringContaining('no license texts kept') })
    expect(await run('licenses --nope')).toMatchObject({ code: 1, err: expect.stringContaining('invalid option') })
    expect(await run('licenses ../../etc')).toMatchObject({ code: 1 })
  }, 60000)
})
