import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `( list )` in the kernel shell: a snapshot of variables, arrays, functions and the directory. */
describe('kernel shell: subshells', () => {
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

  const out = async (script: string) => {
    await kernel.shell.execute(`{\n${script}\n} > /tmp/sub-out`)
    return await kernel.filesystem.fs.readFile('/tmp/sub-out', 'utf-8')
  }

  it('keeps variable, array and directory changes inside', async () => {
    const text = await out('x=1\na=(p q)\n(\n  x=2\n  a+=(r)\n  cd /tmp\n  echo "in $x ${#a[@]} $PWD"\n)\necho "out $x ${#a[@]} $PWD"')
    expect(text).toMatch(/^in 2 3 \/tmp\nout 1 2 (?!\/tmp)/)
  })

  it('exit inside ends only the subshell and sets $?', async () => {
    expect(await out('(echo in; exit 4; echo no)\necho "after $?"')).toBe('in\nafter 4\n')
  })

  it('takes a redirection and can be followed by a statement', async () => {
    await kernel.shell.execute('(echo a; echo b) > /tmp/sub-file; echo c >> /tmp/sub-file')
    expect(await kernel.filesystem.fs.readFile('/tmp/sub-file', 'utf-8')).toBe('a\nb\nc\n')
  })
})
