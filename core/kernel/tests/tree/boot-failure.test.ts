import { describe, expect, it, vi } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { KernelState } from '@ecmaos/types'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

function newKernel() {
  return new Kernel({
    credentials: { username: 'root', password: 'root' },
    dom: TestDomOptions,
    filesystem: DefaultFilesystemOptions,
    log: TestLogOptions
  })
}

/** Makes boot() fail right after the boot spinner starts, and hands back a spy spinner. */
function failAfterSpinner(kernel: Kernel, message: string) {
  const spinner = { start: vi.fn(), stop: vi.fn() }
  vi.spyOn(kernel.terminal, 'spinner').mockReturnValue(spinner as never)
  vi.spyOn(kernel.dom, 'showTtyIndicator').mockImplementation(() => { throw new Error(message) })
  return spinner
}

describe('boot failure leaves an honest UI', () => {
  it('stops the spinner, clears the topbar, and toasts the error message', async () => {
    const kernel = newKernel()
    const spinner = failAfterSpinner(kernel, 'disk on fire')
    const topbar = vi.spyOn(kernel.dom, 'topbar')
    const progress = vi.spyOn(kernel.dom, 'topbarProgress')
    const toast = vi.spyOn(kernel.dom.toast, 'error')

    await expect(kernel.boot()).resolves.toBeUndefined()

    expect(kernel.state).toBe(KernelState.PANIC)
    expect(spinner.start).toHaveBeenCalled()
    expect(spinner.stop).toHaveBeenCalled()
    expect(topbar).toHaveBeenLastCalledWith(false)
    expect(progress).toHaveBeenCalledWith(0)
    expect(toast).toHaveBeenCalledOnce()
    const shown = toast.mock.calls[0]![0] as { message: string }
    expect(shown.message).toContain('kernel panic')
    expect(shown.message).toContain('disk on fire')
  })

  it('still reports the failure when the toast itself cannot be shown', async () => {
    const kernel = newKernel()
    // Fail at boot's very first step: filesystem mounts are module-global, so a later failure point
    // would trip over the mounts the previous test's kernel left behind instead.
    vi.spyOn(kernel.terminal, 'unlisten').mockImplementation(() => { throw new Error('terminal on fire') })
    vi.spyOn(kernel.dom.toast, 'error').mockImplementation(() => { throw new Error('no DOM') })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(kernel.boot()).resolves.toBeUndefined()

    expect(kernel.state).toBe(KernelState.PANIC)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('terminal on fire'))
    consoleError.mockRestore()
  })
})
