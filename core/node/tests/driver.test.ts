import { describe, expect, it } from 'vitest'

import { TerminalDriver } from '../src/driver.ts'
import type { DrivenTerminal } from '../src/driver.ts'

/** A terminal whose `keyHandler` is slow, as it is when the queue is behind (a history recall, a command's own Enter) */
function slowTerminal() {
  const handled: string[] = []
  const given: string[] = []
  let attached = false
  const term: DrivenTerminal = {
    write() {},
    input(data) { given.push(data) },
    async keyHandler(event) {
      // the real handler stands down while a program owns the keyboard, and decides that before its first await
      if (attached) return
      await new Promise(resolve => setTimeout(resolve, 20))
      handled.push(event.key)
    },
    async paste() {},
    resize() {},
    prompt: () => '$ ',
    get ttyInputAttached() { return attached }
  }
  return { term, handled, given, attach: (value: boolean) => { attached = value } }
}

describe('TerminalDriver', () => {
  it('does not give a program\'s keys to the line editor once the program has ended', async () => {
    const { term, handled, given, attach } = slowTerminal()
    const driver = new TerminalDriver(term, true)
    attach(true)
    driver.feed(Buffer.from('root\r'))
    // the program ends before the key queue gets to them
    attach(false)
    await driver.idle
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(given).toEqual(['root\r'])
    expect(handled).toEqual([])
  })

  it('still gives keys to the line editor when no program owns the keyboard', async () => {
    const { term, handled } = slowTerminal()
    const driver = new TerminalDriver(term, true)
    driver.feed(Buffer.from('ls'))
    await driver.idle
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(handled).toEqual(['l', 's'])
  })
})
