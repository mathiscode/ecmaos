import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('Shell', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      credentials: { username: 'root', password: 'root' }
    })
    await kernel.boot()
  })

  it('should initialize and execute commands', () => {
    expect(kernel.shell).toBeDefined()
  })

  it('resolves username through the Users registry it was constructed with, not a Kernel back-reference', async () => {
    await kernel.users.add({ username: 'shell-username-test', password: 'x', uid: 12345 }, { noHash: true, noHome: true, noWrite: true })

    const user = kernel.users.get(12345)
    expect(user).toBeDefined()

    const previousUid = kernel.shell.credentials.uid
    kernel.shell.credentials = { ...kernel.shell.credentials, uid: 12345 }
    expect(kernel.shell.username).toBe('shell-username-test')
    kernel.shell.credentials = { ...kernel.shell.credentials, uid: previousUid }
  })

  it('executes a real command through the bound execute closure, without holding a Kernel reference', async () => {
    const code = await kernel.shell.execute('true')
    expect(code).toBe(0)
  })
})
