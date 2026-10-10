import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { chargeQuota, configureQuotas, parseQuotas, parseQuotaSize } from '#lib/quota.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('reading /etc/quota', () => {
  const resolve = (name: string) => ({ alice: 1001, bob: 1002, root: 0 })[name as 'alice']

  it('takes sizes with units, names or numbers, and comments', () => {
    const { limits, errors } = parseQuotas('# who gets what\nalice 100M\n1002 2g  # bob\n\n', resolve)
    expect(errors).toEqual([])
    expect(limits.get(1001)).toBe(100 * 1024 * 1024)
    expect(limits.get(1002)).toBe(2 * 1024 ** 3)
    expect(parseQuotaSize('1.5k')).toBe(1536)
    expect(parseQuotaSize('12x')).toBeUndefined()
  })

  it('reports a bad line with its number and keeps the good ones', () => {
    const { limits, errors } = parseQuotas('alice 10M\nnobody 5M\nbob lots\nroot 1G\nalice\n', resolve)
    expect([...limits.keys()]).toEqual([1001])
    expect(errors).toEqual([
      "line 2: no such user 'nobody'",
      'line 3: expected USER SIZE (such as alice 100M)',
      'line 4: root has no quota',
      'line 5: expected USER SIZE (such as alice 100M)'
    ])
  })
})

describe('charging growth against a quota', () => {
  it('lets a file grow while the owner fits, refuses past the limit, and finds freed space by measuring', () => {
    let used = 0
    configureQuotas(new Map([[1001, 1000]]), () => used)
    const file = { uid: 1001, size: 0 }
    chargeQuota(file, 600, '/home/a')
    file.size = 600
    // the estimate says 1200 would not fit, but the owner has actually freed everything
    used = 0
    chargeQuota(file, 1200, '/home/a')
    // measured use is real this time: 900 used elsewhere, growth of 600 does not fit
    used = 900
    expect(() => chargeQuota(file, 1200, '/home/a')).toThrow(/over the storage quota/)
    try { chargeQuota(file, 1200, '/home/a') } catch (error) { expect((error as { code?: string }).code).toBe('EDQUOT') }
    // another user, and shrinking, are never charged
    chargeQuota({ uid: 1002, size: 0 }, 10_000_000, '/home/b')
    chargeQuota({ uid: 1001, size: 600 }, 100, '/home/a')
    configureQuotas(new Map())
  })
})

describe('the quota command', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    await kernel.users.add({ username: 'alice', password: 'pass1234' })
  })

  const run = async (line: string) => {
    await kernel.shell.execute(`${line} > /root/q.out 2> /root/q.err; echo $? > /root/q.code`)
    const read = async (name: string) => await kernel.filesystem.fs.readFile(`/root/q.${name}`, 'utf-8')
    return { out: await read('out'), err: await read('err'), code: (await read('code')).trim() }
  }

  it('says none is set, then lists what /etc/quota gives with the usage measured', async () => {
    expect((await run('quota')).out).toBe('No quotas set.\n')
    await kernel.filesystem.fs.writeFile('/etc/quota', 'alice 10M\nghost 1M\n')
    const reload = await run('quota -r')
    expect(reload.err).toMatch(/no such user 'ghost'/)
    expect(reload.out).toMatch(/1 quota loaded/)
    const alice = [...kernel.users.all.values()].find(user => user.username === 'alice')!
    await kernel.filesystem.fs.mkdir('/home/aq', { recursive: true })
    await kernel.filesystem.fs.writeFile('/home/aq/data', new Uint8Array(2 * 1024 * 1024))
    await kernel.filesystem.fs.chown('/home/aq/data', alice.uid, alice.gid)
    const listing = await run('quota')
    expect(listing.out).toMatch(/User\s+Used\s+Limit\s+Use%/)
    expect(listing.out).toMatch(/alice\s+2\.0M\s+10M\s+20%/)
    // her home also holds the few hundred bytes `/etc/skel` gave it
    const bytes = Number(/alice\s+(\d+)\s+10485760/.exec((await run('quota -b alice')).out)?.[1])
    expect(bytes).toBeGreaterThanOrEqual(2097152)
    expect(bytes).toBeLessThan(2097152 + 4096)
    expect((await run('quota nobody')).code).toBe('1')
  })
})
