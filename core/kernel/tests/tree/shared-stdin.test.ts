import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * A redirected block shares one open input among its commands, the way processes share a file
 * descriptor: a real command reads from where the last reader stopped, and hands back what it did
 * not consume.
 */
describe('a redirected block shares its stdin with real commands', () => {
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

  const fs = () => kernel.filesystem.fs
  const run = async (script: string) => {
    await kernel.shell.execute(`${script} > /tmp/ss-out`)
    return await fs().readFile('/tmp/ss-out', 'utf-8')
  }

  it('gives cat the rest of the file after read took the first line', async () => {
    await fs().writeFile('/tmp/ss-in', 'first\nsecond\nthird\n')
    expect(await run('while read a; do echo "a=$a"; cat; done < /tmp/ss-in')).toBe('a=first\nsecond\nthird\n')
  })

  it('a command that ignores stdin leaves it for the next read', async () => {
    await fs().writeFile('/tmp/ss-in', 'one\ntwo\n')
    expect(await run('while read a; do echo "[$a]"; done < /tmp/ss-in')).toBe('[one]\n[two]\n')
  })

  it('an echo in the loop body does not starve the loop', async () => {
    await fs().writeFile('/tmp/ss-in', 'x\ny\nz\n')
    expect(await run('while read a; do /bin/echo "got $a"; done < /tmp/ss-in')).toBe('got x\ngot y\ngot z\n')
  })

  it('a brace group shares one input, and read then cat continue from the same place', async () => {
    await fs().writeFile('/tmp/ss-in', 'first\nsecond\nthird\n')
    expect(await run('{ read a; echo "a=$a"; cat; } < /tmp/ss-in')).toBe('a=first\nsecond\nthird\n')
  })

  it('a multi-line brace group takes a redirection on its closing brace', async () => {
    await kernel.shell.executeScriptText('{\n  echo one\n  echo two\n} > /tmp/ss-group\n')
    expect(await fs().readFile('/tmp/ss-group', 'utf-8')).toBe('one\ntwo\n')
  })
})

describe('eval and source inherit the pipe they sit in', () => {
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

  const fs = () => kernel.filesystem.fs
  const run = async (script: string) => {
    await kernel.shell.execute(`${script} > /tmp/ev-out`)
    return await fs().readFile('/tmp/ev-out', 'utf-8')
  }

  it('eval writes into a pipe', async () => {
    expect(await run(`eval 'echo x; echo y' | grep y`)).toBe('y\n')
  })

  it('source writes into a pipe', async () => {
    await fs().writeFile('/tmp/ev-src', 'echo from-source\n')
    expect(await run('source /tmp/ev-src | cat')).toBe('from-source\n')
  })

  it('eval reads the pipe it is fed by', async () => {
    expect(await run(`echo piped | eval cat`)).toBe('piped\n')
  })

  it('a pipeline with eval in the middle passes data through', async () => {
    expect(await run(`echo abc | eval 'tr a-z A-Z' | cat`)).toBe('ABC\n')
  })
})
