import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/bzip2`, `xz`, `zstd` and `lz4` are C programs built to WebAssembly (`core/utils/wasm/*`), each with links for the other names. */
describe('bzip2, xz, zstd and lz4', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    await kernel.filesystem.fs.writeFile('/tmp/z.txt', 'the quick brown fox jumps over the lazy dog\n'.repeat(2000))
  })

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/z.out 2> /tmp/z.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/z.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/z.err', 'utf8') }
  }

  for (const [tool, ext, decompress, cat] of [['bzip2', 'bz2', 'bunzip2', 'bzcat'], ['xz', 'xz', 'unxz', 'xzcat'], ['zstd', 'zst', 'unzstd', 'zstdcat'], ['lz4', 'lz4', 'unlz4', 'lz4cat']] as const) {
    it(`${tool} compresses, ${decompress} restores it, and ${cat} reads it`, async () => {
      const fs = kernel.filesystem.fs
      const original = await fs.readFile('/tmp/z.txt', 'utf8')
      await fs.writeFile(`/tmp/c-${tool}.txt`, original)
      // zstd and lz4, unlike the other two, keeps its input unless told not to
      const rm = tool === 'zstd' || tool === 'lz4' ? ' --rm' : ''
      expect((await run(`${tool}${rm} /tmp/c-${tool}.txt`)).code).toBe(0)
      expect(await fs.exists(`/tmp/c-${tool}.txt`)).toBe(false)
      const packed = await fs.readFile(`/tmp/c-${tool}.txt.${ext}`)
      expect(packed.length).toBeLessThan(original.length / 10)
      expect((await run(`${cat} /tmp/c-${tool}.txt.${ext} | wc -c`)).out.trim()).toBe(String(original.length))
      expect((await run(`${decompress}${rm} /tmp/c-${tool}.txt.${ext}`)).code).toBe(0)
      expect(await fs.readFile(`/tmp/c-${tool}.txt`, 'utf8')).toBe(original)
    }, 60000)

    it(`${tool} works as a filter and rejects a file that is not its format`, async () => {
      expect((await run(`${tool} -c < /tmp/z.txt | ${tool} -dc | wc -c`)).out.trim()).toBe(String((await kernel.filesystem.fs.readFile('/tmp/z.txt')).length))
      const bad = await run(`${tool} -dc /tmp/z.txt`)
      expect(bad.code).not.toBe(0)
      expect(bad.err).not.toBe('')
    }, 60000)
  }

  it('a compressed file keeps the modification time of the original (utimensat)', async () => {
    const fs = kernel.filesystem.fs
    await fs.writeFile('/tmp/mt.txt', 'data\n'.repeat(100))
    const when = new Date('2020-02-03T04:05:06Z')
    await fs.utimes('/tmp/mt.txt', when, when)
    expect((await run('zstd -k /tmp/mt.txt')).code).toBe(0)
    expect((await fs.stat('/tmp/mt.txt.zst')).mtime.getTime()).toBe(when.getTime())
  }, 60000)
})
