import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return true; await sleep(50) }
  return false
}

const boot = async () => {
  const kernel = new Kernel({
    credentials: { username: 'root', password: 'root' },
    dom: TestDomOptions,
    filesystem: DefaultFilesystemOptions,
    log: TestLogOptions
  })
  await kernel.boot()
  const container = document.createElement('div')
  document.body.appendChild(container)
  kernel.terminal.mount(container)
  // Stopping the kernel for real would reload the page; what it was asked to do is what matters here.
  const stop = vi.spyOn(kernel, 'stop').mockResolvedValue(undefined)
  return { kernel, stop }
}

describe('the reboot shortcut and the end of poweroff', () => {
  let kernel: Awaited<ReturnType<typeof boot>>['kernel']
  let stop: Awaited<ReturnType<typeof boot>>['stop']

  beforeAll(async () => { ({ kernel, stop } = await boot()) })

  it('the reboot shortcut asks init to reboot instead of reloading the page itself', async () => {
    const reboot = vi.spyOn(kernel, 'reboot').mockResolvedValue(undefined)
    kernel.requestReboot()
    expect(await until(() => stop.mock.calls.length > 0, 15_000)).toBe(true)
    expect(stop).toHaveBeenCalledWith('reboot')
    expect(reboot).not.toHaveBeenCalled()
  }, 30_000)

  it('halt only shuts the kernel down; poweroff also tries to close the page', async () => {
    stop.mockRestore()
    const close = vi.spyOn(globalThis, 'close').mockImplementation(() => {})
    await kernel.stop('halt')
    expect(close).not.toHaveBeenCalled()
    await kernel.stop('poweroff')
    expect(close).toHaveBeenCalledOnce()
    close.mockRestore()
  })

  it('poweroff still stops the kernel when the browser will not close the page', async () => {
    const close = vi.spyOn(globalThis, 'close').mockImplementation(() => { throw new Error('Scripts may close only the windows that were opened by them') })
    await expect(kernel.stop('poweroff')).resolves.toBeUndefined()
    close.mockRestore()
  })
})
