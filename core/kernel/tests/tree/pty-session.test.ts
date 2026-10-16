import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { createPty, ptyIndices } from '#lib/pty.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** A program run on a pty the kernel holds the master of: what a terminal window does. */
describe('programs on a kernel-held pty', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })
  afterAll(() => { for (const index of ptyIndices()) void index })

  it('runs a shell on the slave and talks to it through the master', async () => {
    const pty = createPty({ cols: 100, rows: 30 })
    let seen = ''
    const decoder = new TextDecoder()
    pty.onData(data => { seen += decoder.decode(data) })

    const proc = await kernel.spawnOnPty({ username: 'root', pty, command: '/bin/ecmash', args: ['-l'] })
    expect(proc.tty).toBe(pty.slave)
    pty.write('echo marker-$((6*7))\n')
    await until(() => seen.includes('marker-42'))
    expect(seen).toContain('marker-42')

    pty.write('exit\n')
    await Promise.race([proc.exited, until(() => false, 5000).catch(() => undefined)])
    pty.close()
    expect(ptyIndices()).not.toContain(pty.index)
  })
})
