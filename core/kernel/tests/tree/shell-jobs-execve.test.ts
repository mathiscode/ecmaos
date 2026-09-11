import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Polls `check` until it returns true or `timeoutMs` elapses. `onProcess` fires synchronously
 * inside `executeViaExecve`, but that itself runs after several of the shell's own await points
 * (prepareCommand's expansions, buildOutputStreams, etc.) -- a fixed sleep is either too short
 * under load (flaky) or needlessly long normally, so poll instead.
 */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * Real, execve-backed proof that a backgrounded/foregrounded `js` pipeline stage's `Job` actually
 * acquires a real `@zenfs/linux` Process handle (via `KernelExecuteOptions.onProcess`, wired from
 * `Kernel.executeViaExecve`), and that signaling it through that handle does something real -- not
 * just a mocked assertion. `@zenfs/linux`'s own `Process.kill` (see `process.js`'s `default_action`
 * dispatch) synchronously exits an unhandled `SIGINT`/`SIGTERM` recipient with code `128 + signal`,
 * which is what this test observes through `proc.exited`/`job.done`. This is the real-process
 * counterpart to `shell-jobs.test.ts`'s pure-coreutil job-table tests, and to `execve-js.test.ts`'s
 * proof that `.js` files run through real `execve`.
 */
describe('Shell job control — real @zenfs/linux Process handles', () => {
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

  it('a backgrounded .js pipeline stage registers a real process handle on its Job', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/job-spin.js', 'await new Promise(r => setTimeout(r, 1000))', { mode: 0o755 })

    await kernel.shell.execute('/tmp/job-spin.js &')

    const jobs = kernel.shell.listJobs()
    const job = jobs[jobs.length - 1]!
    await waitFor(() => job.processes.length === 1)
    expect(job.processes.length).toBe(1)
    expect(typeof job.processes[0]!.pid).toBe('number')

    // Real SIGKILL-style cleanup so this job doesn't keep running into later tests/leak a worker.
    job.processes[0]!.kill(9)
    await job.done
  })

  it('Signal.INT (^C\'s signal) on a real process handle terminates it with the POSIX 128+signal exit code', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/job-spin2.js', 'await new Promise(r => setTimeout(r, 5000))', { mode: 0o755 })

    await kernel.shell.execute('/tmp/job-spin2.js &')

    const job = kernel.shell.listJobs()[kernel.shell.listJobs().length - 1]!
    await waitFor(() => job.processes.length === 1)
    expect(job.processes.length).toBe(1)

    const delivered = job.processes[0]!.kill(2) // Signal.INT
    expect(delivered).toBe(true)

    const codes = await job.done
    // 128 + SIGINT(2) = 130, the same code a real shell reports for a ^C-killed foreground job.
    expect(codes[0]).toBe(130)
    expect(job.status).toBe('done')
  })

  it('Terminal ^C delivers Signal.INT to the real foreground job\'s process', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/job-fg.js', 'await new Promise(r => setTimeout(r, 5000))', { mode: 0o755 })

    const promise = kernel.shell.execute('/tmp/job-fg.js')
    await waitFor(() => kernel.shell.foregroundJob !== undefined && kernel.shell.foregroundJob.processes.length === 1)

    const job = kernel.shell.foregroundJob
    expect(job).toBeDefined()
    expect(job!.processes.length).toBe(1)

    await kernel.terminal.keyHandler({
      key: 'c',
      domEvent: { key: 'c', ctrlKey: true, shiftKey: false, altKey: false } as KeyboardEvent
    })

    const code = await promise
    expect(code).toBe(130)
  })
})
