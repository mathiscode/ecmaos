import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Polls `check` until it returns true or `timeoutMs` elapses. `onProcess` fires synchronously
 * inside `executeViaExecve`, but that itself runs after several of the shell's own await points
 * (prepareCommand's expansions, buildOutputStreams, etc.) - a fixed sleep is either too short
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
 * A backgrounded or foregrounded `js` pipeline stage's `Job` gets a real `@zenfs/linux` Process handle (via
 * `KernelExecuteOptions.onProcess`), and signalling through it works: an unhandled `SIGINT`/`SIGTERM` exits the
 * process with `128 + signal`, observed through `proc.exited` and `job.done`.
 */
describe('Shell job control - real @zenfs/linux Process handles', () => {
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

  /**
   * `TIOCGPGRP`/`TIOCSPGRP` answer from `tty.foreground`, which `Kernel.executeViaExecve` must set. A foreground
   * stage takes over the terminal, a backgrounded one never does, and `fg`/`bg` move that ownership.
   */
  it('a foreground .js process becomes the tty\'s foreground process, and gives it back on exit', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/job-tty-fg.js', 'await new Promise(r => setTimeout(r, 300))', { mode: 0o755 })

    const promise = kernel.shell.execute('/tmp/job-tty-fg.js')
    await waitFor(() => kernel.shell.foregroundJob !== undefined && kernel.shell.foregroundJob.processes.length === 1)

    const proc = kernel.shell.foregroundJob!.processes[0]!
    expect(kernel.terminal.zfsTty?.foreground?.pid).toBe(proc.pid)

    await promise
    expect(kernel.terminal.zfsTty?.foreground?.pid).not.toBe(proc.pid)
  })

  it('a backgrounded .js process never takes over the tty\'s foreground', async () => {
    // Comparing pids, not the `Process` objects themselves - vitest's pretty-printer chokes on
    // the struct-backed fields a real `@zenfs/linux` `Process` carries when it has to render one
    // for a failure diff, which is a test-tooling wrinkle, not something this assertion cares about.
    const beforePid = kernel.terminal.zfsTty?.foreground?.pid

    await kernel.filesystem.fs.writeFile('/tmp/job-tty-bg.js', 'await new Promise(r => setTimeout(r, 300))', { mode: 0o755 })
    await kernel.shell.execute('/tmp/job-tty-bg.js &')

    const jobs = kernel.shell.listJobs()
    const job = jobs[jobs.length - 1]!
    await waitFor(() => job.processes.length === 1)

    expect(kernel.terminal.zfsTty?.foreground?.pid).toBe(beforePid)
    await job.done
  })

  it('fg gives a resumed stopped job the tty back; bg takes it away again', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/job-tty-fgbg.js', 'await new Promise(r => setTimeout(r, 2000))', { mode: 0o755 })

    const promise = kernel.shell.execute('/tmp/job-tty-fgbg.js')
    await waitFor(() => kernel.shell.foregroundJob !== undefined && kernel.shell.foregroundJob.processes.length === 1)

    const job = kernel.shell.foregroundJob!
    const proc = job.processes[0]!
    expect(kernel.terminal.zfsTty?.foreground?.pid).toBe(proc.pid)

    // `^Z`: stops the job and must give the tty back (real tty semantics - a stopped process
    // group doesn't own the terminal).
    await kernel.terminal.keyHandler({
      key: 'z',
      domEvent: { key: 'z', ctrlKey: true, shiftKey: false, altKey: false } as KeyboardEvent
    })
    expect(job.status).toBe('stopped')
    expect(kernel.terminal.zfsTty?.foreground?.pid).not.toBe(proc.pid)

    // `bg`: resumes it, but it stays out of the foreground.
    kernel.shell.bg()
    expect(kernel.terminal.zfsTty?.foreground?.pid).not.toBe(proc.pid)

    // `fg`: reclaims the terminal.
    const fgPromise = kernel.shell.fg()
    await waitFor(() => kernel.terminal.zfsTty?.foreground?.pid === proc.pid)
    expect(kernel.terminal.zfsTty?.foreground?.pid).toBe(proc.pid)

    proc.kill(9)
    await fgPromise
    await promise
  })

  /**
   * Regression: `executeViaExecve` once restored `tty.foreground` using `isForeground` captured at spawn, so a job
   * started in the background and later `fg`'d never released the tty on exit and swallowed the next job's `^C`/`^Z`.
   * It now checks `tty.foreground === proc` live.
   */
  it('a job started backgrounded and later fg\'d still releases the tty on exit', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/job-bg-then-fg.js', 'await new Promise(r => setTimeout(r, 200))', { mode: 0o755 })

    await kernel.shell.execute('/tmp/job-bg-then-fg.js &')
    const jobs = kernel.shell.listJobs()
    const job = jobs[jobs.length - 1]!
    await waitFor(() => job.processes.length === 1)

    const proc = job.processes[0]!
    expect(kernel.terminal.zfsTty?.foreground?.pid).not.toBe(proc.pid)

    const fgPromise = kernel.shell.fg()
    await waitFor(() => kernel.terminal.zfsTty?.foreground?.pid === proc.pid)

    await fgPromise
    expect(kernel.terminal.zfsTty?.foreground?.pid).not.toBe(proc.pid)
  })
})
