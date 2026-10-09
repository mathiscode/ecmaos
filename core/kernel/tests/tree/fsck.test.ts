import { beforeAll, describe, expect, it } from 'vitest'
import { Inode, mounts, type StoreFS } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('fsck', () => {
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
  const run = async (line: string) => {
    await kernel.shell.execute(`${line} > /root/fsck.out 2> /root/fsck.err; echo $? > /root/fsck.code`)
    const read = async (name: string) => await fs().readFile(`/root/fsck.${name}`, 'utf-8')
    return { out: await read('out'), err: await read('err'), code: (await read('code')).trim() }
  }

  it('finds a clean machine clean, and does not take hard links for a shared inode', async () => {
    await fs().mkdir('/home/check', { recursive: true })
    await fs().writeFile('/home/check/a', 'one')
    await fs().link('/home/check/a', '/home/check/b')
    const result = await run('fsck /home')
    expect(result.code).toBe('0')
    expect(result.out).toMatch(/no problems found/)
    const whole = await run('fsck --read')
    expect(whole.code).toBe('0')
    expect(whole.out).toMatch(/file data read; no problems found/)
    expect((await run('fsck -q /home')).out).toBe('')
  })

  it('reports one inode number used by two unrelated files, and changes nothing', async () => {
    await fs().mkdir('/home/damaged', { recursive: true })
    await fs().writeFile('/home/damaged/first', 'one')
    await fs().writeFile('/home/damaged/second', 'two')
    // what two tabs on one store do: a second name ends up pointing at the first file's inode
    const root = mounts.get('/') as StoreFS
    const directory = await fs().stat('/home/damaged')
    const first = await fs().stat('/home/damaged/first')
    const transaction = root.store.transaction()
    const inode = new Inode((await transaction.get(directory.ino))!)
    const listing = JSON.parse(new TextDecoder().decode((await transaction.get(inode.data))!)) as Record<string, number>
    listing['second'] = first.ino
    await transaction.set(inode.data, new TextEncoder().encode(JSON.stringify(listing)))
    await transaction.commit()
    ;(root as unknown as { _ids: Map<string, number> })._ids.set('/home/damaged/second', first.ino)
    expect((await fs().stat('/home/damaged/second')).ino).toBe(first.ino)
    const result = await run('fsck /home/damaged')
    expect(result.code).toBe('4')
    expect(result.out).toMatch(new RegExp(`inode ${first.ino} is shared by 2 entries .*first.*second|inode ${first.ino} is shared by 2 entries .*second.*first`))
    expect(result.err).toMatch(/1 problem found .*nothing was changed/)
    expect(await fs().readFile('/home/damaged/first', 'utf-8')).toBe('one')
  })

  it('rejects a bad option and more than one directory', async () => {
    expect((await run('fsck --nope')).code).toBe('8')
    expect((await run('fsck /home /etc')).code).toBe('8')
  })
})
