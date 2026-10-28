import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** The files under /etc a Linux user looks for, and `tmpfs` as the name of the memory filesystem. */
describe('/etc defaults', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const run = async (line: string) => {
    const code = await kernel.shell.execute(`${line} > /tmp/o 2> /tmp/e`)
    return { code, out: await fs().readFile('/tmp/o', 'utf-8'), err: await fs().readFile('/tmp/e', 'utf-8') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  })

  it('lays down fstab, environment, issue, machine-id, timezone and profile.d', async () => {
    for (const path of ['/etc/fstab', '/etc/environment', '/etc/issue', '/etc/machine-id', '/etc/timezone']) expect(await fs().exists(path), path).toBe(true)
    expect((await fs().stat('/etc/profile.d')).isDirectory()).toBe(true)
    expect(await fs().readFile('/etc/machine-id', 'utf-8')).toMatch(/^[0-9a-f]{32}\n$/)
    expect((await fs().readFile('/etc/timezone', 'utf-8')).trim()).not.toBe('')
  })

  it('keeps what an administrator wrote', async () => {
    await fs().writeFile('/etc/issue', 'mine\n')
    await kernel.boot().catch(() => {})
    expect(await fs().readFile('/etc/issue', 'utf-8')).toBe('mine\n')
  })

  it('mount -a with the template fstab mounts nothing and succeeds', async () => {
    expect((await run('mount -a')).code).toBe(0)
  })

  it('mounts tmpfs like memory', async () => {
    const mounted = await run('mount -t tmpfs /scratch')
    expect(mounted.err).toBe('')
    expect(mounted.code).toBe(0)
    await fs().writeFile('/scratch/x', 'hi')
    expect(await fs().readFile('/proc/mounts', 'utf-8')).toMatch(/^tmpfs \/scratch tmpfs/m)
    expect(await fs().readFile('/proc/filesystems', 'utf-8')).toMatch(/\btmpfs\b/)
  })

  it('a login shell starts with the variables in /etc/environment', async () => {
    await fs().writeFile('/etc/environment', '# vars\nEDITOR=vim\nGREETING="hello there"\n')
    await kernel.shell.loadProfile()
    const result = await run('{ echo $EDITOR; printenv EDITOR GREETING; }')
    expect(result.err).toBe('')
    expect(result.out).toBe('vim\nvim\nhello there\n')
  })
})
