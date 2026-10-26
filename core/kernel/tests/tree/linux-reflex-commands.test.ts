import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** The commands a Linux user types by reflex: findmnt, mountpoint, lsb_release and the ones the browser cannot do. */
describe('Linux reflex commands', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const run = async (line: string) => {
    const code = await kernel.shell.execute(`${line} > /tmp/o 2> /tmp/e`)
    return { code, out: await fs().readFile('/tmp/o', 'utf-8'), err: await fs().readFile('/tmp/e', 'utf-8') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  }, 60000)

  describe('findmnt', () => {
    it('lists /proc/mounts with a heading', async () => {
      const { out, code } = await run('findmnt')
      expect(code).toBe(0)
      expect(out.split('\n')[0]).toMatch(/^TARGET\s+SOURCE\s+FSTYPE\s+OPTIONS$/)
      expect(out).toMatch(/^\/proc\s+proc\s+proc\s+rw$/m)
    })

    it('finds one mount by its point, by the path inside it, and by its type', async () => {
      expect((await run('findmnt -n -o TARGET /proc')).out).toBe('/proc\n')
      expect((await run('findmnt -n -o TARGET -T /proc/self')).out).toBe('/proc\n')
      expect((await run('findmnt -n -o TARGET -t proc')).out).toBe('/proc\n')
      expect((await run('findmnt -n -o TARGET -t noproc,sysfs,devtmpfs')).out).not.toContain('/proc')
    })

    it('fails with nothing printed when nothing matches', async () => {
      const result = await run('findmnt /no/such/mount')
      expect(result.code).toBe(1)
      expect(result.out).toBe('')
    })

    it('prints pairs, raw and JSON', async () => {
      expect((await run('findmnt -P -o TARGET,FSTYPE /proc')).out).toBe('TARGET="/proc" FSTYPE="proc"\n')
      expect((await run('findmnt -r -n -o FSTYPE,TARGET /proc')).out).toBe('proc /proc\n')
      expect(JSON.parse((await run('findmnt -J -o TARGET /proc')).out)).toEqual({ filesystems: [{ target: '/proc' }] })
    })

    it('refuses an unknown column', async () => {
      const result = await run('findmnt -o NOPE')
      expect(result.code).toBe(1)
      expect(result.err).toContain('unknown column: NOPE')
    })
  })

  describe('mountpoint', () => {
    it('says whether a path is a mount point, in util-linux wording and statuses', async () => {
      expect(await run('mountpoint /proc')).toMatchObject({ code: 0, out: '/proc is a mountpoint\n' })
      expect(await run('mountpoint /etc')).toMatchObject({ code: 1, out: '/etc is not a mountpoint\n' })
      expect(await run('mountpoint -q /proc')).toMatchObject({ code: 0, out: '' })
      expect(await run('mountpoint /no/such')).toMatchObject({ code: 32, out: '' })
      expect((await run('mountpoint /no/such')).err).toBe('mountpoint: /no/such: No such file or directory\n')
    })

    it('follows a symbolic link unless told not to', async () => {
      await fs().symlink('/proc', '/tmp/to-proc')
      expect((await run('mountpoint /tmp/to-proc')).code).toBe(0)
      expect((await run('mountpoint --nofollow /tmp/to-proc')).code).toBe(1)
      expect((await run('mountpoint --show /tmp/to-proc')).out).toBe('/proc\n')
    })

    it('refuses the device number options it cannot answer', async () => {
      const result = await run('mountpoint -d /proc')
      expect(result.code).toBe(1)
      expect(result.err).toContain('device numbers are not available')
    })
  })

  describe('lsb_release', () => {
    it('reads /etc/os-release', async () => {
      const all = (await run('lsb_release -a')).out
      expect(all).toMatch(/^LSB Version:\tn\/a\nDistributor ID:\tecmaOS\nDescription:\tecmaOS \S+\nRelease:\t\S+\nCodename:\tn\/a\n$/)
      expect((await run('lsb_release -s -i')).out).toBe('ecmaOS\n')
      expect((await run('lsb_release -ds')).out).toMatch(/^ecmaOS \S+\n$/)
      expect((await run('lsb_release -r')).out).toMatch(/^Release:\t\S+\n$/)
    })
  })

  describe('diff3', () => {
    const three = async (mine: string, older: string, yours: string) => {
      await fs().writeFile('/tmp/d3m', mine); await fs().writeFile('/tmp/d3o', older); await fs().writeFile('/tmp/d3y', yours)
    }

    it('lists the blocks as GNU does and exits 0', async () => {
      await three('a\nb\n', 'a\nc\n', 'a\nd\n')
      expect(await run('diff3 /tmp/d3m /tmp/d3o /tmp/d3y')).toEqual({ code: 0, err: '', out: '====\n1:2c\n  b\n2:2c\n  c\n3:2c\n  d\n' })
    })

    it('merges what one side changed and brackets what both did, with status 1', async () => {
      await three('a\nb\nz\n', 'a\nc\nz\n', 'a\nd\nz\n')
      const merged = await run('diff3 -m -L m -L o -L y /tmp/d3m /tmp/d3o /tmp/d3y')
      expect(merged).toEqual({ code: 1, err: '', out: 'a\n<<<<<<< m\nb\n||||||| o\nc\n=======\nd\n>>>>>>> y\nz\n' })
      await three('a\nc\nz\n', 'a\nc\nz\n', 'a\nc\ny\n')
      expect((await run('diff3 -m /tmp/d3m /tmp/d3o /tmp/d3y'))).toEqual({ code: 0, err: '', out: 'a\nc\ny\n' })
    })

    it('reports a missing file and refuses ed scripts', async () => {
      expect(await run('diff3 /tmp/d3m /tmp/d3o /tmp/nope')).toMatchObject({ code: 2, err: 'diff3: /tmp/nope: No such file or directory\n' })
      expect((await run('diff3 -e /tmp/d3m /tmp/d3o /tmp/d3y')).code).toBe(2)
    })
  })

  describe('what a browser tab cannot do', () => {
    it.each(['unshare', 'chroot', 'nsenter'])('%s says why and fails', async (name) => {
      const result = await run(`${name} /bin/sh`)
      expect(result.code).toBe(1)
      expect(result.err).toMatch(new RegExp(`^${name}: there (are no namespaces|is no way)`))
      expect((await run(`${name} --version`)).code).toBe(0)
    })
  })
})
