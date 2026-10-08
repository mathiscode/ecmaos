import { beforeAll, describe, expect, it } from 'vitest'
import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `ecmash` started by the kernel gets its stderr as a pipe the kernel pumps to the terminal, while its
 * stdout is the console itself. A child's error went down the pipe on the pump's own timing, so it could
 * print after what `ecmash` wrote to stdout next (the prompt). The stderr pump now wakes when the pipe is written (the stdout one still polls, see below).
 */
describe('stderr of an ecmash child keeps its place on the terminal', () => {
  let kernel: Kernel
  const screen = () => {
    const b = kernel.terminal.buffer.active
    let t = ''
    for (let i = 0; i < b.length; i++) t += (b.getLine(i)?.translateToString(true) ?? '') + '\n'
    return t
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  it('prints each error before the output that follows it', async () => {
    for (let i = 0; i < 5; i++) {
      await kernel.shell.execute(`ecmash -c 'ls /nope${i}; echo after${i}'`)
      await new Promise(r => setTimeout(r, 100))
    }
    const text = screen()
    for (let i = 0; i < 5; i++) {
      expect(text.indexOf(`/nope${i}'`)).toBeGreaterThan(-1)
      expect(text.indexOf(`/nope${i}'`)).toBeLessThan(text.indexOf(`after${i}\n`))
    }
  }, 60000)

  it('loses nothing of a large stderr sent to a file, or of a large stdout through a pipe', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/big.txt', 'x'.repeat(200_000))
    await kernel.shell.execute('ecmash -c "cat /tmp/big.txt >&2" 2> /tmp/big.err')
    expect((await kernel.filesystem.fs.readFile('/tmp/big.err')).length).toBe(200_000)
    // The stdout pump polls: waking it as the stderr one does cut a transfer like this short at a multiple of 64 KiB
    await kernel.shell.execute('cat /tmp/big.txt | ecmash -c "cat" | wc -c > /tmp/big.count')
    expect((await kernel.filesystem.fs.readFile('/tmp/big.count', 'utf-8')).trim()).toBe('200000')
  }, 60000)
})
