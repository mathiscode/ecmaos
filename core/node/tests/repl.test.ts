import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Session } from './session.ts'

// The REPL needs a terminal, which the tests get from Python's `pty` module
const havePty = process.platform !== 'win32' && spawnSync('python3', ['--version']).status === 0
const major = Number(process.versions.node.split('.')[0])
const Shell = 'root:/root# '

describe.skipIf(!havePty || major < 24)('the node REPL', () => {
  let session: Session

  /** Types into the REPL and waits for `expected` to show up after what was typed */
  const type = async (text: string, expected: string) => {
    const mark = session.output.length
    session.send(text)
    await session.waitFor(expected, mark, 15_000)
    return session.output.slice(mark)
  }

  beforeAll(async () => {
    session = new Session(['--quiet', '--ephemeral'], { pty: { cols: 100, rows: 30 } })
    await session.ready()
  })
  afterAll(async () => { await session.stop() })

  it('starts on a terminal and evaluates what you type', async () => {
    const mark = session.output.length
    session.send('node\r')
    await session.waitFor('Type ".help" for more information.', mark, 20_000)
    await session.waitFor('> ', mark)
    expect(await type('1 + 1\r', '2')).toContain('2')
  })

  it('keeps variables, awaits at the top level, and prints console output through the guest terminal', async () => {
    await type('const x = 21\r', 'undefined')
    expect(await type('x * 2\r', '42')).toContain('42')
    expect(await type('await Promise.resolve("later")\r', 'later')).toContain('later')
    expect(await type('console.log("printed")\r', 'printed')).toContain('printed')
  })

  it('recalls history with the arrow keys and cancels a line with ^C', async () => {
    const out = await type('\x1b[A\x1b[A\r', 'later')
    expect(out).toContain('later')
    session.send('half a line')
    await session.waitFor('half a line', session.output.length - 'half a line'.length - 1)
    const mark = session.output.length
    session.send('\x03')
    await session.waitFor('> ', mark)
    // the REPL is still there and works
    expect(await type('"alive"\r', 'alive')).toContain('alive')
  })

  it('saves the session to a file in the guest filesystem', async () => {
    expect(await type('.save /root/session.js\r', 'Session saved to: /root/session.js')).toContain('saved')
  })

  it('exits on ^D and gives the shell its terminal back', async () => {
    const mark = session.output.length
    session.send('\x04')
    await session.waitFor(Shell, mark, 10_000)
    // line editing and echo work again
    expect(await session.run('cat /root/session.js')).toContain('const x = 21')
    expect(await session.run('echo back')).toBe('back')
  })

  it('remembers history between sessions', async () => {
    const mark = session.output.length
    session.send('node\r')
    await session.waitFor('Type ".help" for more information.', mark, 20_000)
    await session.waitFor('> ', session.output.indexOf('Type ".help"', mark))
    expect(await type('\x1b[A', '"alive"')).toContain('"alive"')
    session.send('\x15\x04')
    await session.waitFor(Shell, session.output.length - 1, 10_000)
  })
})
