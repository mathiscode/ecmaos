import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now()
  while (!await check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(r => setTimeout(r, 20))
  }
}

/** The prompt must not erase a line a command left unfinished: `cat` of a file with no final newline. */
describe('the prompt after a command whose output has no final newline', () => {
  let kernel: Kernel
  const lines = () => {
    const buffer = kernel.terminal.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '')
    return out
  }
  const event = (key: string) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {} }) as unknown as KeyboardEvent
  const keys = (key: string, domEvent: KeyboardEvent) => (kernel.terminal as unknown as { keyHandler(e: { key: string, domEvent: KeyboardEvent }): Promise<unknown> }).keyHandler({ key, domEvent })
  const run = async (text: string) => {
    for (const char of text) await keys(char, event(char))
    await keys('\r', event('Enter'))
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
    await kernel.filesystem.fs.writeFile('/tmp/no-newline', '3')
    await kernel.filesystem.fs.writeFile('/tmp/with-newline', '4\n')
  })

  it('keeps the output and draws the prompt on the next line', async () => {
    await run('cat /tmp/no-newline')
    await waitFor(() => lines().some(line => line === '3'))
    await waitFor(() => lines().filter(line => line.includes(':/')).length >= 2)
    const all = lines()
    const at = all.indexOf('3')
    expect(all[at + 1]).toMatch(/#|\$/)
  })

  it('still clears the line when the output ended with a newline', async () => {
    await run('cat /tmp/with-newline')
    await waitFor(() => lines().includes('4'))
    // the prompt is drawn after the command's exit is noticed, a moment after its output appears
    await waitFor(() => /#|\$/.test(lines()[lines().indexOf('4') + 1] ?? ''))
    const all = lines()
    expect(all[all.indexOf('4') + 1]).toMatch(/#|\$/)
  })
})
