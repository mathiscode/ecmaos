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

describe('the reboot shortcut', () => {
  it('asks init to reboot instead of reloading the page itself', async () => {
    const { kernel, stop } = await boot()
    const reboot = vi.spyOn(kernel, 'reboot').mockResolvedValue(undefined)
    kernel.requestReboot()
    const went = await until(() => stop.mock.calls.length > 0, 15_000)
    expect(went, JSON.stringify({ code: kernel.init.process?.code, thread: !!kernel.init.process?.thread, kids: [...kernel.init.process!.children].map(c => c.comm + ':' + c.code) })).toBe(true)
    expect(stop).toHaveBeenCalledWith('reboot')
    expect(reboot).not.toHaveBeenCalled()
  }, 30_000)
})
