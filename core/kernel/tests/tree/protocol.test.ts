import { describe, it, expect } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptionsTest } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('Protocol', () => {
  it('should be defined', () => {
    const kernel = new Kernel()
    expect(kernel.protocol).toBeDefined()
  })

  it('is wired to the real terminal by the time Kernel finishes constructing, not a back-reference to Kernel', async () => {
    const kernel = new Kernel({
      dom: TestDomOptions,
      log: TestLogOptions,
      filesystem: DefaultFilesystemOptionsTest,
      credentials: { username: 'root', password: 'root' }
    })

    const writes: string[] = []
    const original = kernel.terminal.writeln.bind(kernel.terminal)
    kernel.terminal.writeln = ((text: string) => { writes.push(text); return original(text) }) as typeof kernel.terminal.writeln

    kernel.protocol.open('ecmaos://test')
    expect(writes.some(w => w.includes('ecmaos://test'))).toBe(true)

    kernel.terminal.writeln = original
  })
})
