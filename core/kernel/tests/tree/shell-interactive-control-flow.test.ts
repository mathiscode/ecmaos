import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Covers `Shell.execute()` itself (the interactive-prompt path a real terminal calls per line),
 * not just `executeScriptText` (script files) -- `shell-control-flow.test.ts` only proves the
 * parser/executor works when driven through the script path. Regression coverage for:
 * - `x=5; echo $((x+1))` swallowing everything after the assignment into its own value
 * - `if`/`for` typed compact-and-`;`-joined on one physical line ("Command not found: if")
 */
describe('Shell.execute interactive control flow and assignment', () => {
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

  it('splits an assignment from a semicolon-chained statement instead of swallowing it', async () => {
    await kernel.shell.execute('x=5')
    expect(kernel.shell.env.get('x')).toBe('5')

    const code = await kernel.shell.execute('y=1; z=2')
    expect(code).toBe(0)
    expect(kernel.shell.env.get('y')).toBe('1')
    expect(kernel.shell.env.get('z')).toBe('2')
  })

  it('runs a compact single-line if/then/else/fi typed at the prompt', async () => {
    const outPath = '/tmp/interactive-if-test.out'
    if (await kernel.filesystem.fs.exists(outPath)) await kernel.filesystem.fs.unlink(outPath)

    await kernel.shell.execute('x=set')
    const code = await kernel.shell.execute(`if test -n "$x"; then echo yes >> ${outPath}; else echo no >> ${outPath}; fi`)
    const output = await kernel.filesystem.fs.readFile(outPath, 'utf-8')

    expect(code).toBe(0)
    expect(output.trim()).toBe('yes')
  })

  it('runs a compact single-line for/in/do/done typed at the prompt', async () => {
    const outPath = '/tmp/interactive-for-test.out'
    if (await kernel.filesystem.fs.exists(outPath)) await kernel.filesystem.fs.unlink(outPath)

    const code = await kernel.shell.execute(`for i in 1 2 3; do echo $i >> ${outPath}; done`)
    const output = await kernel.filesystem.fs.readFile(outPath, 'utf-8')

    expect(code).toBe(0)
    expect(output.trim().split('\n')).toEqual(['1', '2', '3'])
  })

  it('does not mistake an ordinary argument that spells a keyword for control flow', async () => {
    const outPath = '/tmp/interactive-echo-done-test.out'
    if (await kernel.filesystem.fs.exists(outPath)) await kernel.filesystem.fs.unlink(outPath)

    const code = await kernel.shell.execute(`echo done >> ${outPath}`)
    const output = await kernel.filesystem.fs.readFile(outPath, 'utf-8')

    expect(code).toBe(0)
    expect(output.trim()).toBe('done')
  })
})
