import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Signal } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Resolves true if `promise` settles within `ms`, false if it is still pending. */
const settlesWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))])

/**
 * `^C` and `^Z` go to the terminal's foreground *process group* on Linux. Here the tty holds a single
 * process, so a pipeline's other stages used to be left running: `sleep 20 | cat` then `^C` ended only
 * one of them, and the shell waited for the other to finish before giving the prompt back.
 * `tty.foreground.kill(...)` is exactly what the line discipline does for `ISIG`.
 */
describe('signals from the terminal reach every stage of the foreground job', () => {
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
    for (const name of ['a', 'b']) {
      await kernel.filesystem.fs.writeFile(`/tmp/stage-${name}.js`, 'await new Promise(r => setTimeout(r, 15000))', { mode: 0o755 })
    }
  })

  const start = async () => {
    const run = kernel.shell.execute('/tmp/stage-a.js | /tmp/stage-b.js')
    await waitFor(() => kernel.shell.foregroundJob !== undefined && kernel.shell.foregroundJob.processes.length === 2)
    return { run, job: kernel.shell.foregroundJob! }
  }

  it('^C ends every stage, so the prompt comes back', async () => {
    const { run, job } = await start()
    kernel.terminal.zfsTty!.foreground!.kill(Signal.INT)
    expect(await settlesWithin(run, 2000)).toBe(true)
    expect(job.processes.every(proc => proc.stopped === false)).toBe(true)
  })

  it('^Z stops every stage, fg resumes them all, and ^C then ends them all', async () => {
    const { run, job } = await start()
    kernel.terminal.zfsTty!.foreground!.kill(Signal.TSTP)
    await waitFor(() => job.status === 'stopped')
    expect(job.processes.map(proc => proc.stopped)).toEqual([true, true])

    const resumed = kernel.shell.fg()
    await waitFor(() => job.processes.every(proc => !proc.stopped))
    kernel.terminal.zfsTty!.foreground!.kill(Signal.INT)
    expect(await settlesWithin(resumed, 2000)).toBe(true)
    expect(await settlesWithin(run, 2000)).toBe(true)
  })

  it('a signal sent to one process by pid is not spread to the others', async () => {
    const { run, job } = await start()
    job.processes[0]!.kill(Signal.TERM)
    expect(await settlesWithin(run, 500)).toBe(false) // the other stage is still running
    kernel.terminal.zfsTty!.foreground!.kill(Signal.INT)
    expect(await settlesWithin(run, 2000)).toBe(true)
  })

  it('reports the interrupt to the shell once for the whole pipeline, not once per stage', async () => {
    const notify = vi.spyOn(kernel.shell, 'notifyInterrupted')
    const run = kernel.shell.execute('/tmp/stage-a.js | /tmp/stage-b.js')
    await waitFor(() => kernel.shell.foregroundJob !== undefined && kernel.shell.foregroundJob.processes.length === 2)
    kernel.terminal.zfsTty!.foreground!.kill(Signal.INT)
    expect(await settlesWithin(run, 3000)).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    notify.mockRestore()
  })
})
