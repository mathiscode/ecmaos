import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { DEFAULT_SKEL } from '#lib/skel.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `/etc/skel`: boot fills in what is missing, and a home that `useradd -m` creates starts as a copy of it. */
describe('/etc/skel', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  }, 60000)

  it('is written at boot with the default dotfiles', async () => {
    for (const name of Object.keys(DEFAULT_SKEL)) expect(await fs().exists(`/etc/skel/${name}`)).toBe(true)
    expect(await fs().readFile('/etc/skel/.bashrc', 'utf-8')).toContain("alias ll='ls -alF'")
  })

  it('gives a new home the files, owned by the new user, with the skeleton modes', async () => {
    await kernel.users.add({ username: 'skelly', password: 'skel-pass', uid: 1300, gid: 1300 })
    for (const name of Object.keys(DEFAULT_SKEL)) {
      const file = await fs().stat(`/home/skelly/${name}`)
      expect([file.uid, file.gid, file.mode & 0o777]).toEqual([1300, 1300, 0o644])
    }
    expect(await fs().readFile('/home/skelly/.bashrc', 'utf-8')).toBe(DEFAULT_SKEL['.bashrc']?.content)
  })

  it('copies nested entries, and uses an edited skeleton rather than the default', async () => {
    await fs().mkdir('/etc/skel/.config', { recursive: true })
    await fs().writeFile('/etc/skel/.config/app.toml', 'x = 1\n')
    await fs().writeFile('/etc/skel/.bashrc', '# edited\n')
    await kernel.users.add({ username: 'nested', password: 'nest-pass', uid: 1301, gid: 1301 })
    const copied = await fs().stat('/home/nested/.config/app.toml')
    expect([copied.uid, copied.gid]).toEqual([1301, 1301])
    expect(await fs().readFile('/home/nested/.bashrc', 'utf-8')).toBe('# edited\n')
  })

  it('leaves a home that already exists, and an edited skeleton at the next boot, alone', async () => {
    await fs().mkdir('/home/existing', { recursive: true })
    await fs().writeFile('/home/existing/.bashrc', 'mine\n')
    await kernel.users.add({ username: 'existing', password: 'exist-pass', uid: 1302, gid: 1302 })
    expect(await fs().readFile('/home/existing/.bashrc', 'utf-8')).toBe('mine\n')
    expect(await fs().exists('/home/existing/.profile')).toBe(false)

    const { installSkel } = await import('#lib/skel.ts')
    await installSkel(fs() as never)
    expect(await fs().readFile('/etc/skel/.bashrc', 'utf-8')).toBe('# edited\n')
  })

  it('makes an account without a home when asked for none', async () => {
    await kernel.users.add({ username: 'nohome', password: 'nohome-pw', uid: 1303, gid: 1303 }, { noHome: true })
    expect(await fs().exists('/home/nohome')).toBe(false)
  })
})
