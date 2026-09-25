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

  it('renders the default prompt for the logged-in user: # for root, $ for anyone else', async () => {
    await kernel.users.add({ username: 'prompt-test', password: 'x', uid: 12346 }, { noHash: true, noHome: true, noWrite: true })
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
    const previous = kernel.shell.credentials
    const savedPrompt = kernel.shell.env.get('PROMPT')
    kernel.shell.env.delete('PROMPT')

    try {
      expect(strip(kernel.terminal.prompt())).toMatch(/^root:.*# $/)

      kernel.shell.credentials = { ...previous, uid: 12346, euid: 12346 }
      expect(strip(kernel.terminal.prompt())).toMatch(/^prompt-test:.*\$ $/)
    } finally {
      kernel.shell.credentials = previous
      if (savedPrompt !== undefined) kernel.shell.env.set('PROMPT', savedPrompt)
    }
  })

  it('executes a real command through the bound execute closure, without holding a Kernel reference', async () => {
    const code = await kernel.shell.execute('true')
    expect(code).toBe(0)
  })
})
