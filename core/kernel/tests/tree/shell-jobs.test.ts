import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Real, booted-kernel proof of `&` background execution and the job table's state machine
 * (running -> done, running -> stopped -> running -> done). These pipelines are all-coreutil
 * (`sleep`, `echo`, `true`, `false`) -- see `execve-js.test.ts`/`bin-node-execve.test.ts` for the
 * real-`@zenfs/linux`-Process-backed side of job control (`^C`/`^Z`/`fg`/`bg` actually signaling
 * something), which is out of scope for a plain coreutil pipeline per `Kernel.executeViaExecve`'s
 * and `Terminal`'s own doc comments on what can genuinely be signaled.
 */
describe('Shell job control — & background execution and the job table', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()

    // A migrated coreutil's stdout (e.g. `echo`, since `feat/1.0.0-execve-commands`) is now a real
    // device write to `/dev/console`, not a JS method call on a `Terminal` object -- and
    // `@zenfs/linux`'s own console driver (`drivers/tty/console.js`) genuinely throws `ENXIO` for
    // that write until some terminal has attached at least once (`console_tty` starts `null`; the
    // first attached terminal becomes it, matching real Linux). This suite never displays anything
    // and never mounted one, which was harmless for the old `executeCommand` path (its unredirected
    // stdout never touched a real device at all) but is a real, correct failure now that `echo`'s
    // stdout is real I/O -- so a terminal is mounted here purely to give `/dev/console` a target.
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  it('`&` returns to the caller immediately without waiting for the backgrounded pipeline', async () => {
    const start = Date.now()
    const code = await kernel.shell.execute('sleep 2 &')
    const elapsed = Date.now() - start

    // execute() itself only had to launch the job, not run it -- if this were still treated like
    // `;` (the old behavior) this would take >= 2000ms.
    expect(elapsed).toBeLessThan(500)
    expect(code).toBe(0) // `&`'s own line reports success at the shell level, not the job's eventual exit

    // Let the background job actually finish so it doesn't leak into a later test.
    await kernel.shell.wait()
  })

  it('registers a Job with the command line, background: true, and eventually status "done"', async () => {
    await kernel.shell.execute('echo backgrounded &')
    // Give the microtask queue a beat to register the job before inspecting it.
    await new Promise(resolve => setTimeout(resolve, 10))

    const jobs = kernel.shell.listJobs()
    const job = jobs[jobs.length - 1]
    expect(job).toBeDefined()
    expect(job!.background).toBe(true)
    expect(job!.commandLine).toBe('echo backgrounded')

    const codes = await job!.done
    expect(codes).toEqual([0])
    expect(job!.status).toBe('done')
    expect(job!.exitCodes).toEqual([0])
  })

  it('assigns increasing job ids across multiple backgrounded pipelines', async () => {
    await kernel.shell.execute('true &')
    await new Promise(resolve => setTimeout(resolve, 10))
    const firstId = kernel.shell.listJobs()[kernel.shell.listJobs().length - 1]!.id

    await kernel.shell.execute('true &')
    await new Promise(resolve => setTimeout(resolve, 10))
    const secondId = kernel.shell.listJobs()[kernel.shell.listJobs().length - 1]!.id

    expect(secondId).toBe(firstId + 1)
    await kernel.shell.wait()
  })

  it('`wait` with no argument waits for every currently-tracked non-done job', async () => {
    await kernel.shell.execute('sleep 0.2 &')
    await kernel.shell.execute('sleep 0.3 &')
    await new Promise(resolve => setTimeout(resolve, 10))

    const jobs = kernel.shell.listJobs()
    const pending = jobs.slice(-2)
    expect(pending.every(job => job.status !== 'done')).toBe(true)

    await kernel.shell.wait()
    expect(pending.every(job => job.status === 'done')).toBe(true)
  })

  it('`wait %N` waits for and returns a single job\'s exit code', async () => {
    await kernel.shell.execute('false &')
    await new Promise(resolve => setTimeout(resolve, 10))
    const job = kernel.shell.listJobs()[kernel.shell.listJobs().length - 1]!

    const code = await kernel.shell.wait(`%${job.id}`)
    expect(code).toBe(1)
    expect(job.status).toBe('done')
  })

  it('getJob resolves %%, %+, %-, and bare (most-recent) specs', async () => {
    await kernel.shell.execute('true &')
    await new Promise(resolve => setTimeout(resolve, 10))
    await kernel.shell.execute('true &')
    await new Promise(resolve => setTimeout(resolve, 10))

    const jobs = kernel.shell.listJobs()
    const mostRecent = jobs[jobs.length - 1]!
    const previous = jobs[jobs.length - 2]!

    expect(kernel.shell.getJob()).toBe(mostRecent)
    expect(kernel.shell.getJob('%%')).toBe(mostRecent)
    expect(kernel.shell.getJob('%+')).toBe(mostRecent)
    expect(kernel.shell.getJob('%-')).toBe(previous)
    expect(kernel.shell.getJob(`%${mostRecent.id}`)).toBe(mostRecent)
    expect(kernel.shell.getJob('%nonexistent-command-name')).toBeUndefined()

    await kernel.shell.wait()
  })

  it('foregroundJob is set while a foreground pipeline runs and cleared once it settles', async () => {
    expect(kernel.shell.foregroundJob).toBeUndefined()

    const promise = kernel.shell.execute('sleep 0.2')
    // execute()'s pre-pipeline expansion work (parseCommandSubstitution/tilde/history-bang/glob)
    // has its own await points before runForeground actually registers a job, so poll briefly
    // rather than assuming foregroundJob is set the instant execute() is called.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(kernel.shell.foregroundJob).toBeDefined()
    expect(kernel.shell.foregroundJob!.status).toBe('running')

    await promise
    expect(kernel.shell.foregroundJob).toBeUndefined()
  })

  it('foregroundJob is never set for a backgrounded pipeline', async () => {
    await kernel.shell.execute('sleep 0.1 &')
    expect(kernel.shell.foregroundJob).toBeUndefined()
    await kernel.shell.wait()
  })

  it('bg() on a job that is not stopped is a no-op that returns the job unchanged', async () => {
    await kernel.shell.execute('sleep 0.1 &')
    await new Promise(resolve => setTimeout(resolve, 10))
    const job = kernel.shell.listJobs()[kernel.shell.listJobs().length - 1]!
    expect(job.status).toBe('running')

    const result = kernel.shell.bg(`%${job.id}`)
    expect(result).toBe(job)
    expect(job.status).toBe('running') // unchanged -- bg() only acts on a stopped job

    await kernel.shell.wait()
  })

  it('fg() on an unknown job spec resolves undefined rather than throwing', async () => {
    const code = await kernel.shell.fg('%does-not-exist')
    expect(code).toBeUndefined()
  })

  it('wait() on an unknown job spec resolves undefined rather than throwing', async () => {
    const code = await kernel.shell.wait('%does-not-exist')
    expect(code).toBeUndefined()
  })

  it('a pure-coreutil job never acquires a real process handle', async () => {
    await kernel.shell.execute('true &')
    await new Promise(resolve => setTimeout(resolve, 10))
    const job = kernel.shell.listJobs()[kernel.shell.listJobs().length - 1]!
    expect(job.processes).toEqual([])
    await kernel.shell.wait()
  })
})
