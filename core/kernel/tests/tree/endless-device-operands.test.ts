import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * A device has no length, so commands read an operand until they have enough or it ends. An endless one (`/dev/zero`,
 * `/dev/random`) must not be read to the end by a command that was asked for a few bytes.
 */
describe('commands given an endless device as a file operand', () => {
  let kernel: Kernel
  const run = async (command: string) => {
    await kernel.shell.execute(`${command} > /tmp/endless-out`)
    return await kernel.filesystem.fs.readFile('/tmp/endless-out', 'utf8')
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  })

  afterAll(() => { /* the kernel is left to the process */ })

  it('head -c stops after its bytes', async () => {
    expect((await run('head -c 6 /dev/zero | wc -c')).trim()).toBe('6')
  }, 15000)

  it('od -N stops after its bytes', async () => {
    expect(await run('od -An -N 4 -tx1 /dev/zero')).toContain('00 00 00 00')
  }, 15000)

  it('xxd -l stops after its bytes, and -s skips first', async () => {
    expect(await run('xxd -l 20 /dev/zero')).toBe('00000000: 0000 0000 0000 0000 0000 0000 0000 0000  ................\n00000010: 0000 0000                                ....\n')
    expect(await run('xxd -s 4 -l 2 /dev/zero')).toBe('00000004: 0000                                     ..\n')
  }, 15000)

  it('wc counts a device that ends', async () => {
    expect((await run('wc -c /dev/null')).trim()).toBe('0 /dev/null')
  }, 15000)

  it('cat of a device that ends gives its bytes (/dev/null is empty)', async () => {
    expect(await run('cat /dev/null')).toBe('')
  }, 15000)
})
