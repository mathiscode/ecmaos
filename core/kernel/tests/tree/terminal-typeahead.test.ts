import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Keys reach the terminal from events that do not wait for the handler to finish: xterm's `onKey`, or, where the
 * browser has touch (as jsdom says it does), a hidden input's `input` and `keydown`. These type into that input, without
 * waiting, as someone typing ahead does.
 */
describe('Terminal typeahead', () => {
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

  const press = (char: string) => {
    const input = (kernel.terminal as unknown as { _mobileInputElement: HTMLInputElement })._mobileInputElement
    // the terminal empties the input itself after an Enter
    if (char === '\r') return void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    input.value += char
    input.dispatchEvent(new Event('input'))
  }
  const type = (text: string) => { for (const char of text) press(char === '\n' ? '\r' : char) }
  const settle = async (path: string, lines: number) => {
    for (let i = 0; i < 200; i++) {
      const text = await kernel.filesystem.fs.exists(path) ? await kernel.filesystem.fs.readFile(path, 'utf-8') : ''
      if (text.split('\n').filter(Boolean).length >= lines) return text
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return kernel.filesystem.fs.readFile(path, 'utf-8')
  }

  it('runs lines typed ahead in the order they were typed', async () => {
    type('echo 1 >> /tmp/ta-a\necho 2 >> /tmp/ta-a\necho 3 >> /tmp/ta-a\n')
    expect(await settle('/tmp/ta-a', 3)).toBe('1\n2\n3\n')
  }, 20_000)

  it('runs lines typed during a program, and during the ones typed ahead of it, in order', async () => {
    type('/bin/sleep 0.3; echo 1 >> /tmp/ta-b\n')
    await new Promise(resolve => setTimeout(resolve, 100))
    type('/bin/sleep 0.3; echo 2 >> /tmp/ta-b\necho 3 >> /tmp/ta-b\n')
    await new Promise(resolve => setTimeout(resolve, 400))
    type('echo 4 >> /tmp/ta-b\n')
    expect(await settle('/tmp/ta-b', 4)).toBe('1\n2\n3\n4\n')
  }, 20_000)

  it('throws away the lines waiting at ^C', async () => {
    type('/bin/sleep 1\necho dropped >> /tmp/ta-c\n')
    await new Promise(resolve => setTimeout(resolve, 300))
    const input = (kernel.terminal as unknown as { _mobileInputElement: HTMLInputElement })._mobileInputElement
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))
    await new Promise(resolve => setTimeout(resolve, 1500))
    type('echo kept >> /tmp/ta-c\n')
    expect(await settle('/tmp/ta-c', 1)).toBe('kept\n')
  }, 20_000)
})
