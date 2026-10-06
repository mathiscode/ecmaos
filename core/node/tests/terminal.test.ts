import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Session } from './session.ts'

// A real TTY needs a pseudo-terminal, which the tests get from Python's `pty` module
const havePty = process.platform !== 'win32' && spawnSync('python3', ['--version']).status === 0
const major = Number(process.versions.node.split('.')[0])

describe.skipIf(!havePty || major < 24)('terminal on a pseudo-terminal', () => {
  let session: Session

  beforeAll(async () => {
    session = new Session(['--quiet'], { pty: { cols: 100, rows: 30 } })
    await session.ready()
  })

  afterAll(async () => { await session.stop() })

  it('recalls history with the arrow keys', async () => {
    expect(await session.run('echo one')).toBe('one')
    // Up, Enter, in one write: the recall is asynchronous and the Enter must still run what was recalled
    const mark = session.output.length
    session.send('\x1b[A\r')
    await session.waitFor('one', mark + 'echo one'.length)
    const out = session.output.slice(mark)
    expect(out.match(/^one$/gm)).toHaveLength(1)
  })

  it('edits the line with Home, the arrows, Backspace and Delete', async () => {
    const mark = session.output.length
    const right = '\x1b[C'
    // "echo xbad": Backspace the x from after it, then Delete the b from after "echo "; what is left is "echo ad"
    session.send(`echo xbad\x1b[H${right.repeat(6)}\x7f\x1b[H${right.repeat(5)}\x1b[3~\r`)
    await session.waitFor('ad', mark + 'echo xbad'.length)
    expect(session.output.slice(mark)).toMatch(/^ad$/m)
  })

  it('moves by word with Alt and by line with Ctrl', async () => {
    const mark = session.output.length
    // "echo one two": Alt-b back over "two", Ctrl-k kills from there; Ctrl-a, Ctrl-e round-trip; leaves "echo one "
    session.send('echo one two\x1bb\x0b\x01\x05\r')
    await session.waitFor('one', mark + 'echo one two'.length)
    expect(session.output.slice(mark)).toMatch(/^one$/m)
  })

  it('completes a path with Tab', async () => {
    await session.run('echo tabbed > /tmp/tabcomplete-target')
    const mark = session.output.length
    session.send('cat /tmp/tabcomplete-tar\t\r')
    await session.waitFor('tabbed', mark + 'cat /tmp/tabcomplete-tar'.length)
    expect(session.output.slice(mark)).toMatch(/^tabbed$/m)
  })

  it('inserts a bracketed paste as text, without running it', async () => {
    const mark = session.output.length
    session.send('\x1b[200~echo pasted\x1b[201~')
    await session.waitFor('echo pasted', mark)
    // not run yet: nothing but the line itself appeared
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(session.output.slice(mark).match(/^pasted$/gm)).toBeNull()
    expect(await session.run('')).toBe('pasted')
  })

  it('interrupts a running command with ^C', async () => {
    const before = session.output.length
    session.send('sleep 60\r')
    await session.waitFor('sleep 60', before)
    await new Promise(resolve => setTimeout(resolve, 300))
    session.send('\x03')
    await session.waitFor('^C', before)
    expect(await session.run('echo alive')).toBe('alive')
  })

  it('reports the window size, and follows a resize', async () => {
    expect(await session.run('stty size')).toBe('30 100')
    session.resize(60, 20)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await session.run('stty size')).toBe('20 60')
  })
})

describe.skipIf(major < 24)('terminal on pipes', () => {
  it('runs a script of lines in order, even when they arrive in one chunk', async () => {
    const session = new Session(['--quiet'])
    try {
      await session.ready()
      const mark = session.output.length
      session.send('echo a\recho b\recho c\r')
      await session.waitFor('c', mark + 'echo c'.length + 10)
      const lines = session.output.slice(mark).split('\n').filter(line => /^[abc]$/.test(line))
      expect(lines).toEqual(['a', 'b', 'c'])
    } finally { await session.stop() }
  })
})
