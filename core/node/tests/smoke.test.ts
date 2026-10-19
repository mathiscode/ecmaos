import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Session } from './session.ts'

// The package needs Node 24 (`engines`); the main CI job runs `.nvmrc`'s older Node, and a dedicated job covers 24 and 26
const supported = Number(process.versions.node.split('.')[0]) >= 24

describe.skipIf(!supported)('the bundled Node kernel', () => {
  const session = new Session()

  beforeAll(async () => { await session.ready() })
  afterAll(async () => { await session.stop() })

  it('runs a program', async () => {
    expect(await session.run('echo hello from node')).toBe('hello from node')
  })

  it('runs a pipeline', async () => {
    expect(await session.run('echo a b c | tr a-z A-Z')).toBe('A B C')
  })

  it('identifies itself', async () => {
    expect(await session.run('whoami')).toBe('root')
    // the kernel name is Linux, as programs that test for it expect; the version names ecmaOS
    expect(await session.run('uname')).toBe('Linux')
    expect(await session.run('uname -v')).toMatch(/^#1 .*ecmaos/i)
  })

  it('lists the built-in commands', async () => {
    expect(Number(await session.run('ls /bin | wc -l'))).toBeGreaterThan(100)
  })

  it('keeps files in its filesystem', async () => {
    await session.run('echo kept > /tmp/kept.txt')
    expect(await session.run('cat /tmp/kept.txt')).toBe('kept')
  })
})
