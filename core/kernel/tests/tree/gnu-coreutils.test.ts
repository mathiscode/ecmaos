import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'
import { buffers, cases } from './fixtures/gnu-coreutils.corpus.mjs'
import golden from './fixtures/gnu-coreutils.golden.json'
import { known } from './fixtures/gnu-coreutils.known'

/**
 * The coreutils against what GNU printed for the same commands on the same files (fixtures/gnu-coreutils.golden.json, made by
 * generate-gnu-coreutils.mjs): standard output and the exit status always. Differences that are accepted are pinned in
 * fixtures/gnu-coreutils.known.ts with their reason.
 */
const latin1 = (bytes: Uint8Array) => Array.from(bytes, byte => String.fromCharCode(byte)).join('')

type Golden = { cmd: string, out: string, code: number, err: string }

describe('coreutils match GNU', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const fs = kernel.filesystem.fs
    await fs.mkdir('/tmp/gnuc/dir', { recursive: true })
    for (const [name, data] of Object.entries(buffers)) await fs.writeFile(`/tmp/gnuc/${name}`, data as Uint8Array)
  })

  afterAll(() => { /* the kernel is left to the process */ })

  for (const expected of golden as Golden[]) {
    it(expected.cmd, async () => {
      const fs = kernel.filesystem.fs
      await kernel.shell.execute(`cd /tmp/gnuc; ${expected.cmd} > /tmp/gnuc-out 2> /tmp/gnuc-err; echo $? > /tmp/gnuc-code`)
      const code = Number((await fs.readFile('/tmp/gnuc-code', 'utf8')).trim())
      const out = latin1(await fs.readFile('/tmp/gnuc-out'))
      const err = latin1(await fs.readFile('/tmp/gnuc-err'))
      const accepted = known[expected.cmd]
      if (accepted) expect({ out, code }, accepted.reason).toEqual({ out: accepted.out, code: accepted.code })
      else expect({ out, code }).toEqual({ out: expected.out, code: expected.code })
    }, 30000)
  }
})

// Keeps the corpus and the golden file from drifting apart
describe('the GNU corpus', () => {
  it('has a golden result for every command', () => {
    expect((golden as Golden[]).map(entry => entry.cmd)).toEqual(cases)
  })
})
