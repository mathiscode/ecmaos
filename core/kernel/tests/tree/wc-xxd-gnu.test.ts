import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'
import golden from './fixtures/wc-xxd.golden.json'

/**
 * `wc` and `xxd` against what GNU `wc` and `xxd` printed for the same inputs (fixtures/wc-xxd.golden.json, made by running
 * them on these files): standard output and the exit status always, and the error message where the command names one.
 */
const latin1 = (bytes: Uint8Array) => Array.from(bytes, byte => String.fromCharCode(byte)).join('')
const bytes = (text: string) => Uint8Array.from(text, char => char.charCodeAt(0))

const files: Record<string, Uint8Array> = {
  'a.txt': bytes('one two\nthree  four five\n\nlast line no newline'),
  'u.txt': bytes('h\xc3\xa9llo w\xc3\xb6rld\n\ttabbed\tline\n'),
  'empty.txt': bytes(''),
  'bin.dat': bytes('The quick brown fox jumps over the lazy dog, twice over: abc\x00\x01\xff\n')
}

// xxd's own wording for what it does not recognise is its usage text, which these do not copy
const statusOnly = new Set(['xxd -z a.txt', 'xxd -l abc a.txt', 'wc -x a.txt'])

describe('wc and xxd match GNU', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const fs = kernel.filesystem.fs
    await fs.mkdir('/tmp/gnu/dir', { recursive: true })
    for (const [name, data] of Object.entries(files)) await fs.writeFile(`/tmp/gnu/${name}`, data)
  })

  afterAll(() => { /* the kernel is left to the process */ })

  for (const expected of golden as Array<{ cmd: string, out: string, code: number, err: string }>) {
    it(expected.cmd, async () => {
      const fs = kernel.filesystem.fs
      await kernel.shell.execute(`cd /tmp/gnu; ${expected.cmd} > /tmp/gnu-out 2> /tmp/gnu-err; echo $? > /tmp/gnu-code`)
      const code = Number((await fs.readFile('/tmp/gnu-code', 'utf8')).trim())
      const out = latin1(await fs.readFile('/tmp/gnu-out'))
      const err = await fs.readFile('/tmp/gnu-err', 'utf8')
      expect({ out, code }).toEqual({ out: expected.out, code: expected.code })
      if (!statusOnly.has(expected.cmd)) expect(err).toBe(expected.err)
    }, 20000)
  }
})
