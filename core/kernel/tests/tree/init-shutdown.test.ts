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

describe('going down through init', () => {
  let kernel: Kernel
  let stop: ReturnType<typeof vi.fn>

  beforeAll(async () => { ({ kernel, stop } = await boot()); await sleep(1500) })
  afterAll(() => { stop.mockRestore() })

  it('refuses the system calls to anyone but root, and init to anyone but root', async () => {
    const credentials = kernel.shell.credentials
    kernel.shell.credentials = { ...credentials, uid: 1000, gid: 1000, suid: 1000, sgid: 1000, euid: 1000, egid: 1000 }
    try {
      const before = kernel.shell.credentials.suid
      const status = await kernel.shell.execute('reboot -f 2> /tmp/refused.err')
      expect(status, JSON.stringify({ calls: stop.mock.calls, before, suid: kernel.shell.credentials.suid, same: kernel.shell.credentials === credentials })).toBe(1)
      expect(await kernel.filesystem.fs.readFile('/tmp/refused.err', 'utf-8')).toMatch(/reboot: .*(permitted|root)/i)
      expect(await kernel.shell.execute('kill -TERM 1')).not.toBe(0)
      await sleep(200)
    } finally {
      kernel.shell.credentials = credentials
    }
    expect(stop).not.toHaveBeenCalled()
    expect(processes.get(1)!.code).toBeUndefined()
  })

  it('reboot -f, halt -f and poweroff -f stop the kernel at once, without init', async () => {
    expect(await kernel.shell.execute('reboot -f')).toBe(0)
    expect(await kernel.shell.execute('halt -f')).toBe(0)
    expect(await kernel.shell.execute('poweroff -f')).toBe(0)
    expect(stop.mock.calls.map(call => call[0])).toEqual(['reboot', 'halt', 'poweroff'])
    expect(processes.get(1)!.code).toBeUndefined()
    expect(await kernel.shell.execute('halt --nonsense 2> /dev/null')).toBe(1)
  })

  it('halt runs the shutdown entries, stops the other processes, then stops the kernel', async () => {
    stop.mockClear()
    await kernel.filesystem.fs.writeFile('/tmp/bye.js', [
      'const { open, write, close, O_WRONLY, O_CREAT, O_TRUNC, custom } = globalThis.ecmaosSyscalls',
      "const fd = open('/tmp/bye.out', O_WRONLY | O_CREAT | O_TRUNC, 0o644)",
      "write(fd, new TextEncoder().encode('crond-still-alive'))",
      'close(fd)'
    ].join('\n'), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/tmp/stubborn.js', [
      'globalThis.ecmaosSyscalls.onSignal(15, () => {})',
      'await new Promise(() => {})'
    ].join('\n'), { mode: 0o755 })
    const inittab = await kernel.filesystem.fs.readFile('/etc/inittab', 'utf-8')
    await kernel.filesystem.fs.writeFile('/etc/inittab', inittab + '::shutdown:/tmp/bye.js\n')
    await kernel.shell.execute('kill -HUP 1')
    await kernel.shell.execute('/tmp/stubborn.js &')
    const live = (name: string) => [...processes.values()].find(proc => proc.comm === name && proc.code === undefined)
    expect(await until(() => !!live('stubborn.js') && !!live('crond'))).toBe(true)
    const crond = live('crond')!
    const stubborn = live('stubborn.js')!

    await kernel.shell.execute('halt')
    expect(await until(() => stop.mock.calls.length > 0, 15_000)).toBe(true)

    expect(stop).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledWith('halt')
    expect(crond.code).toBeDefined()          // stopped by SIGTERM
    expect(crond.killed_by).toBe(15)
    expect(stubborn.killed_by).toBe(9)        // ignored SIGTERM, so SIGKILL
    expect(await kernel.filesystem.fs.readFile('/tmp/bye.out', 'utf-8')).toBe('crond-still-alive')
    expect(processes.get(1)!.code).toBeUndefined() // pid 1 does not exit
  }, 30_000)
})
