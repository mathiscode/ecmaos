import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import createWasiPreview1Bindings from '#wasi/preview1.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `poll_oneoff` used to be a bare stub returning ENOSYS (52) unconditionally, which fails any
 * preview1 program that calls it at all -- including ones that only use it for a trivial "is my
 * fd ready" check rather than a real blocking wait. This proves the real implementation: it
 * parses the WASI `subscription_t`/`event_t` binary layout correctly and reports every
 * subscription as resolved immediately (this file's fds are never genuinely not-yet-ready outside
 * of stdin, which has its own asyncify-driven blocking path elsewhere in preview1.ts).
 */
describe('wasi preview1 poll_oneoff', () => {
  let kernel: Kernel
  let poll_oneoff: (subs: number, events: number, n: number, nevents: number) => number
  let memory: WebAssembly.Memory

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()

    const streams = {
      stdin: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
      stdout: new WritableStream<Uint8Array>(),
      stderr: new WritableStream<Uint8Array>()
    }

    const { imports, setMemory } = createWasiPreview1Bindings({
      kernel,
      streams,
      args: [],
      hasAsyncify: false,
      memoryRequirements: { initial: 1 },
      shell: kernel.shell
    })

    memory = new WebAssembly.Memory({ initial: 1 })
    setMemory(memory)

    const wasi = imports.wasi_snapshot_preview1 as Record<string, (...args: number[]) => number>
    poll_oneoff = wasi.poll_oneoff as typeof poll_oneoff
  })

  const SUBSCRIPTION_SIZE = 48
  const EVENT_SIZE = 32

  function writeClockSubscription(base: number, userdata: bigint, timeoutNs: bigint): void {
    const view = new DataView(memory.buffer)
    view.setBigUint64(base, userdata, true)
    view.setUint8(base + 8, 0) // eventtype: clock
    view.setBigUint64(base + 24, timeoutNs, true)
  }

  function writeFdSubscription(base: number, userdata: bigint, type: 1 | 2, fd: number): void {
    const view = new DataView(memory.buffer)
    view.setBigUint64(base, userdata, true)
    view.setUint8(base + 8, type)
    view.setUint32(base + 16, fd, true)
  }

  it('resolves a single clock subscription immediately with no error', () => {
    const subsPtr = 0
    const eventsPtr = 256
    const neventsPtr = 512

    writeClockSubscription(subsPtr, 42n, 1_000_000_000n)

    const result = poll_oneoff(subsPtr, eventsPtr, 1, neventsPtr)
    expect(result).toBe(0)

    const view = new DataView(memory.buffer)
    expect(view.getUint32(neventsPtr, true)).toBe(1)
    expect(view.getBigUint64(eventsPtr, true)).toBe(42n)
    expect(view.getUint16(eventsPtr + 8, true)).toBe(0) // no error
    expect(view.getUint8(eventsPtr + 10)).toBe(0) // eventtype: clock
  })

  it('resolves an fd_read subscription on a valid fd (stdin) with no error', () => {
    const subsPtr = 0
    const eventsPtr = 256
    const neventsPtr = 512

    writeFdSubscription(subsPtr, 7n, 1, 0)

    const result = poll_oneoff(subsPtr, eventsPtr, 1, neventsPtr)
    expect(result).toBe(0)

    const view = new DataView(memory.buffer)
    expect(view.getUint32(neventsPtr, true)).toBe(1)
    expect(view.getBigUint64(eventsPtr, true)).toBe(7n)
    expect(view.getUint16(eventsPtr + 8, true)).toBe(0)
    expect(view.getUint8(eventsPtr + 10)).toBe(1) // eventtype: fd_read
  })

  it('reports EBADF for a subscription on an unopened fd', () => {
    const subsPtr = 0
    const eventsPtr = 256
    const neventsPtr = 512

    writeFdSubscription(subsPtr, 1n, 2, 99)

    poll_oneoff(subsPtr, eventsPtr, 1, neventsPtr)

    const view = new DataView(memory.buffer)
    expect(view.getUint16(eventsPtr + 8, true)).toBe(8) // EBADF
  })

  it('handles multiple subscriptions in one call, one event per subscription', () => {
    const subsPtr = 0
    const eventsPtr = 512
    const neventsPtr = 1024

    writeClockSubscription(subsPtr, 1n, 0n)
    writeFdSubscription(subsPtr + SUBSCRIPTION_SIZE, 2n, 1, 0)

    poll_oneoff(subsPtr, eventsPtr, 2, neventsPtr)

    const view = new DataView(memory.buffer)
    expect(view.getUint32(neventsPtr, true)).toBe(2)
    expect(view.getBigUint64(eventsPtr, true)).toBe(1n)
    expect(view.getBigUint64(eventsPtr + EVENT_SIZE, true)).toBe(2n)
  })
})
