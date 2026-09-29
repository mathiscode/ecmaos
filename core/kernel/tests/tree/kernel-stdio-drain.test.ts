import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * A redirected command's output is fully written before its exit code is reported.
 *
 * `Kernel.executeViaExecve` used to `await new Promise(r => setTimeout(r, 15))` and hope, because a
 * program's stdout reaches a file through a main-thread pump (`bridgeFd`) rather than the program
 * writing the file itself. 15ms is a guess, and under load not a good one: a loaded parallel test run
 * intermittently read a half-written redirect target while the identical case passed every time in
 * isolation. Each pump already drained its pipe fully once the program closed its end, so there was a
 * real completion signal to await all along.
 *
 * A mid-pipeline stage is deliberately exempt, and that exemption is load-bearing rather than a
 * shortcut: the next stage's own reads already order the data, and a downstream program that exits
 * early stops reading, fills the pipe, and would leave the upstream drain waiting forever.
 */
describe('redirected stdio drains before a command is reported done', () => {
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

  const read = async (path: string): Promise<string> =>
    await kernel.filesystem.fs.readFile(path, 'utf-8') as unknown as string

  it('has every byte in the file by the time the next statement runs', async () => {
    // One statement writes, the very next reads. Nothing sleeps in between, which is the whole point.
    const code = await kernel.shell.execute('seq 1 200 > /tmp/drain-seq.txt && wc -l < /tmp/drain-seq.txt > /tmp/drain-count.txt')
    expect(code).toBe(0)
    expect((await read('/tmp/drain-count.txt')).trim()).toBe('200')
  })

  it('does not truncate a large redirect', async () => {
    const code = await kernel.shell.execute('seq 1 5000 > /tmp/drain-large.txt')
    expect(code).toBe(0)
    const lines = (await read('/tmp/drain-large.txt')).split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(5000)
    expect(lines[4999]).toBe('5000')
  })

  it('drains a heredoc body written through a redirect', async () => {
    // The exact case that flaked: `cat <<EOF > f` then reading `f` immediately.
    const code = await kernel.shell.executeScriptText("cat <<'EOF' > /tmp/drain-heredoc.txt\nvalue is \\$x\nEOF\n")
    expect(code).toBe(0)
    expect(await read('/tmp/drain-heredoc.txt')).toBe('value is \\$x\n')
  })

  it('drains stderr to its own file', async () => {
    await kernel.shell.execute('ls /definitely-not-here 2> /tmp/drain-stderr.txt')
    expect((await read('/tmp/drain-stderr.txt')).length).toBeGreaterThan(0)
  })

  it('still finishes a pipeline whose downstream stage stops reading early', async () => {
    // The reason mid-pipeline stdout is exempt. Awaiting the upstream drain here would wait on a pipe
    // nobody is emptying. It has to terminate, and it has to terminate quickly.
    const started = Date.now()
    const code = await kernel.shell.execute('seq 1 20000 | head -n 1 > /tmp/drain-head.txt')
    expect(code).toBe(0)
    expect((await read('/tmp/drain-head.txt')).trim()).toBe('1')
    expect(Date.now() - started).toBeLessThan(20000)
  })

  it('carries a full pipeline through to its redirected last stage', async () => {
    const code = await kernel.shell.execute('seq 1 500 | grep -c . > /tmp/drain-pipe.txt')
    expect(code).toBe(0)
    expect((await read('/tmp/drain-pipe.txt')).trim()).toBe('500')
  })
})
