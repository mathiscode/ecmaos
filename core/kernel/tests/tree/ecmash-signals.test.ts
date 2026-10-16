import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * A status of 130 is only a `^C` when a foreground process really died of SIGINT. Found by hand: `kill -INT`
 * on a background job, then `wait` on it, ended the whole script, because `wait` itself returned 130.
 */
describe('ecmash: a job that was sent INT is not an interrupt of the script', () => {
  let kernel: Kernel
  let serial = 0

  const run = async (script: string) => {
    const base = `/tmp/ecmash-sig-${serial++}`
    await kernel.filesystem.fs.writeFile(`${base}.sh`, script)
    const code = await kernel.shell.execute(`ecmash ${base}.sh > ${base}.out 2> ${base}.err`)
    return { code, out: await kernel.filesystem.fs.readFile(`${base}.out`, 'utf-8'), err: await kernel.filesystem.fs.readFile(`${base}.err`, 'utf-8') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  it('wait gives the 130 of a background program that was sent INT, and the script goes on', async () => {
    const result = await run('sleep 3 & p=$!\nkill -INT $p\nwait $p\necho "after=$?"\necho next')
    expect(result.out).toBe('after=130\nnext\n')
    expect(result.code).toBe(0)
  }, 30000)

  it('every time: the kill lands at any point in the job\'s start-up without wedging the shell', async () => {
    // killpg on a group that is already gone is refused by the kernel; the shell must wait for that answer rather
    // than let the rejection escape (an unhandled rejection stopped the worker, and the script never went on)
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await run('sleep 3 & p=$!\nkill -INT $p\nsleep 0.2\necho one\nwait $p\necho "after=$?"')
      expect(result.out).toBe('one\nafter=130\n')
    }
  }, 60000)

  it('and so does a background subshell', async () => {
    const result = await run('(sleep 3; echo x) & p=$!\nkill -INT $p\nwait $p\necho "after=$?"\necho next')
    expect(result.out).toBe('after=130\nnext\n')
    expect(result.code).toBe(0)
  }, 30000)

  it('an ordinary 130 from a builtin or a subshell does not end the script', async () => {
    const result = await run('(exit 130)\necho "a=$?"\nsh -c "exit 130"\necho "b=$?"\necho end')
    expect(result.out).toBe('a=130\nb=130\nend\n')
  }, 30000)

  it('jobs says Terminated for a job ended by TERM, and Exit 143 only for a plain exit status', async () => {
    const result = await run('sleep 3 & p=$!\nkill $p\nsleep 0.4\njobs\nsh -c "exit 143" &\nsleep 0.4\njobs')
    expect(result.out).toMatch(/\[1\][+-] +Terminated +sleep 3/)
    expect(result.out).toMatch(/\[2\][+-] +Exit 143 +sh -c/)
  }, 30000)
})
