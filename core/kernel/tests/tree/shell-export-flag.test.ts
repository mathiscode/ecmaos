import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** Only exported variables are part of a command's environment, as in a real shell. */
describe('the exported flag', () => {
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

  const lines = async (script: string) => {
    await kernel.shell.execute(`{\n${script}\n} > /tmp/export-flag-out`)
    return (await kernel.filesystem.fs.readFile('/tmp/export-flag-out', 'utf-8')).split('\n').filter(Boolean)
  }

  it('keeps a plain assignment out of the environment until export', async () => {
    const out = await lines('EF_PLAIN=1\nexport EF_NAMED=2\nenv | grep -E "^EF_(PLAIN|NAMED)="\necho --\nexport EF_PLAIN\nenv | grep -E "^EF_(PLAIN|NAMED)="')
    expect(out[0]).toBe('EF_NAMED=2')
    expect(out[1]).toBe('--')
    expect(out.slice(2).sort()).toEqual(['EF_NAMED=2', 'EF_PLAIN=1'])
  })

  it('export NAME marks an existing variable and keeps its value', async () => {
    const out = await lines('EF_BARE=v\nexport EF_BARE\nenv | grep EF_BARE')
    expect(out).toEqual(['EF_BARE=v'])
  })

  it('declare -x exports', async () => {
    const out = await lines('declare -x EF_DECL=1\nEF_PLAIN2=2\nenv | grep -E "^EF_(DECL|PLAIN2)="')
    expect(out).toEqual(['EF_DECL=1'])
  })

  it('a prefix assignment is in that command environment only', async () => {
    const out = await lines('EF_P=outer\nEF_P=inner env | grep "^EF_P="\necho "after=$EF_P"\nenv | grep -c "^EF_P="')
    expect(out).toEqual(['EF_P=inner', 'after=outer', '0'])
  })

  it('an inherited variable stays exported when reassigned, and a shell-created one does not leak through unset and reassign', async () => {
    const out = await lines('PATH=$PATH:/x\nenv | grep -c "^PATH="\nEF_T=1\nunset EF_T\nEF_T=2\nenv | grep -c EF_T')
    expect(out).toEqual(['1', '0'])
  })
})
