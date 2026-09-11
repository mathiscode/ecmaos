import { beforeAll, describe, it, expect, vi } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { Process, ProcessManager } from '#processes.ts'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

import { ProcessEvents } from '@ecmaos/types'
import type { ProcessEntryParams, ProcessExitEvent } from '@ecmaos/types'

describe('Process Manager', () => {
  let kernel: Kernel

  beforeAll(() => {
    kernel = new Kernel({
      devices: {},
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
  })

  it('should instantiate a process manager', () => {
    expect(new ProcessManager()).toBeInstanceOf(ProcessManager)
  })

  it('should manage the lifetime of a process', async () => {
    const canaryCode = Math.floor(Math.random() * 100)
    const process = new Process({
      entry: (params: ProcessEntryParams) => new Promise(resolve => {
        params.terminal.write('entry')
        setTimeout(() => resolve(canaryCode), 200)
      }),
      uid: 0,
      gid: 0,
      context: kernel.context,
      filesystem: kernel.filesystem,
      processes: kernel.processes,
      kernel,
      shell: kernel.shell,
      terminal: kernel.terminal
    })

    kernel.processes.add(process)
    process.start()
    expect(kernel.processes.get(process.pid)?.status).toEqual('running')

    return new Promise((resolve, reject) => {
      process.events.on<ProcessExitEvent>(ProcessEvents.EXIT, ({ pid, code }) => {
        if (code !== canaryCode) return reject(`Process exited with invalid code; expected ${canaryCode} but got ${code}`)
        if (kernel.processes.get(pid)) return reject('Process was not removed from the manager')
        resolve(code)
      })
    })
  })

  describe('constructor dependencies', () => {
    it('uses the injected filesystem and context directly for PID files, not a Kernel back-reference', async () => {
      const process = new Process({
        entry: () => new Promise(resolve => setTimeout(() => resolve(0), 50)),
        uid: 0,
        gid: 0,
        command: 'pidfile-test',
        context: kernel.context,
        filesystem: kernel.filesystem,
        processes: kernel.processes,
        kernel,
        shell: kernel.shell,
        terminal: kernel.terminal
      })

      process.keepAlive()
      const started = process.start()

      // keepAlive's PID file write is fire-and-forget; give it a tick to land before the entry
      // (which resolves after 50ms) finishes. keepAlive means start() never auto-stops, so the
      // file is expected to persist -- this only proves the write went through kernel.filesystem.
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(await kernel.filesystem.fs.exists(`/run/pidfile-test/${process.pid}.pid`)).toBe(true)

      await started
      await process.stop()
      expect(await kernel.filesystem.fs.exists(`/run/pidfile-test/${process.pid}.pid`)).toBe(false)
    })

    it('only reads options.kernel to populate ProcessEntryParams.kernel for the entry callback', async () => {
      let receivedKernel: unknown
      const process = new Process({
        entry: async params => { receivedKernel = params.kernel; return 0 },
        uid: 0,
        gid: 0,
        context: kernel.context,
        filesystem: kernel.filesystem,
        processes: kernel.processes,
        kernel,
        shell: kernel.shell,
        terminal: kernel.terminal
      })

      await process.start()
      expect(receivedKernel).toBe(kernel)
    })
  })

  describe('stream cleanup', () => {
    it('should close custom streams on process exit', async () => {
      // Create custom streams with spies
      let stdinCancelled = false
      let stdoutClosed = false
      let stderrClosed = false

      const customStdin = new ReadableStream({
        cancel: () => { stdinCancelled = true }
      })

      const customStdout = new WritableStream({
        close: () => { stdoutClosed = true }
      })

      const customStderr = new WritableStream({
        close: () => { stderrClosed = true }
      })

      const process = new Process({
        entry: () => Promise.resolve(0),
        uid: 0,
        gid: 0,
        context: kernel.context,
        filesystem: kernel.filesystem,
        processes: kernel.processes,
        kernel,
        shell: kernel.shell,
        terminal: kernel.terminal,
        stdin: customStdin,
        stdout: customStdout,
        stderr: customStderr
      })

      await process.start()

      // Verify custom streams were closed
      expect(stdinCancelled).toBe(true)
      expect(stdoutClosed).toBe(true)
      expect(stderrClosed).toBe(true)
    })

    it('should NOT close terminal streams on process exit', async () => {
      // Spy on terminal stream methods
      const terminalStdinCancel = vi.spyOn(kernel.terminal.stdin, 'cancel')
      const terminalStdoutClose = vi.spyOn(kernel.terminal.stdout, 'close')
      const terminalStderrClose = vi.spyOn(kernel.terminal.stderr, 'close')

      const process = new Process({
        entry: () => Promise.resolve(0),
        uid: 0,
        gid: 0,
        context: kernel.context,
        filesystem: kernel.filesystem,
        processes: kernel.processes,
        kernel,
        shell: kernel.shell,
        terminal: kernel.terminal
        // Using terminal's default streams (no custom streams)
      })

      await process.start()

      // Verify terminal streams were NOT closed
      expect(terminalStdinCancel).not.toHaveBeenCalled()
      expect(terminalStdoutClose).not.toHaveBeenCalled()
      expect(terminalStderrClose).not.toHaveBeenCalled()

      // Cleanup spies
      terminalStdinCancel.mockRestore()
      terminalStdoutClose.mockRestore()
      terminalStderrClose.mockRestore()
    })
  })
})
