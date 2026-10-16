import { describe, expect, it } from 'vitest'

import { usePosixKernel } from './fixtures/posix-fileops'

/** `stat -f` and `touch -h`, against GNU coreutils 9. */
describe('POSIX file operations: file system status and symlink times', { timeout: 120000 }, () => {
  const { run } = usePosixKernel()

  describe('stat -f', () => {
    it('reports the block and inode counts with the format sequences', async () => {
      const r = await run('', "stat -f -c '%n %l %s %S' /tmp")
      expect(r.code).toBe(0)
      expect(r.out).toBe('/tmp 255 4096 4096\n')
    })
    it('free blocks never exceed the total, available never exceeds free', async () => {
      const r = await run('', "stat -f -c '%b %f %a' /tmp")
      const [total, free, available] = r.out.trim().split(' ').map(Number)
      expect(free).toBeLessThanOrEqual(total!)
      expect(available).toBeLessThanOrEqual(free!)
    })
    it('the default report has GNU\'s five lines', async () => {
      const r = await run('', 'stat -f /tmp')
      expect(r.out.split('\n').slice(0, 5).map(line => line.trim().split(/[ :]/)[0])).toEqual(['File', 'ID', 'Block', 'Blocks', 'Inodes'])
    })
    it('a missing path is an error', async () => {
      const r = await run('', 'stat -f /nope')
      expect(r.code).toBe(1)
      expect(r.err).toBe("stat: cannot read file system information for '/nope': No such file or directory\n")
    })
  })

  describe('touch -h', () => {
    it('stamps the symlink and leaves its target alone', async () => {
      const r = await run('echo x > f; ln -s f l; touch -d @1000 f', "{ touch -h -d @2000 l; stat -c '%Y' f; stat -c '%Y' l; }")
      expect(r.code).toBe(0)
      expect(r.out).toBe('1000\n2000\n')
    })
    it('stamps a dangling symlink instead of creating its target', async () => {
      const r = await run('ln -s nowhere l', "{ touch -h -d @3000 l; stat -c '%Y' l; ls nowhere; }")
      expect(r.out).toBe('3000\n')
      expect(r.code).not.toBe(0)
    })
    it('without -h the target is stamped', async () => {
      const r = await run('echo x > f; ln -s f l; touch -d @1000 f', "{ touch -d @2000 l; stat -c '%Y' f; }")
      expect(r.out).toBe('2000\n')
    })
  })
})
