import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** A line the parser rejects is a bash syntax error: a message and status 2, not an exception out of `execute`. */
describe('syntax errors', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  it.each([`echo "abc`, `echo 'abc`, 'echo `x', 'echo ok; echo "b'])('%s exits 2', async line => {
    await expect(kernel.shell.execute(line)).resolves.toBe(2)
    expect(kernel.shell.env.get('?')).toBe('2')
  })

  it('a syntax error in a branch not taken is found before the compound command runs', async () => {
    await kernel.shell.execute('unset SYN_RAN')
    await expect(kernel.shell.execute('if false; then echo a ); fi; SYN_RAN=1')).resolves.toBe(2)
    expect(kernel.shell.env.get('SYN_RAN')).toBeUndefined()
  })

  it('the shell carries on with the next line', async () => {
    await kernel.shell.execute('echo "abc')
    await expect(kernel.shell.execute('true')).resolves.toBe(0)
  })

  it('a script with an open quote exits 2 instead of throwing', async () => {
    await expect(kernel.shell.executeScriptText('echo a\necho "b\n')).resolves.toBe(2)
  })
})
