import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { KernelDevice, KernelDeviceCLIOptions } from '@ecmaos/types'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * A device's command line (`/dev/<name> args`) runs under a real `/bin/devcli` process: the device's own
 * `cli` still runs main-thread side (the hardware APIs live there) and its output travels to the process's
 * stdout through a pipe fd. `/dev/battery` is a real node in the test environment; its `cli` is swapped for a
 * fixture to drive each behaviour.
 */
describe('device command lines under a real process', () => {
  let kernel: Kernel
  let original: KernelDevice
  let seen: KernelDeviceCLIOptions | undefined

  const useCli = (cli: NonNullable<KernelDevice['cli']>) => {
    const entry = kernel.devices.get('battery')!
    kernel.devices.set('battery', { ...entry, device: { ...original, cli } })
  }
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/dev.out 2> /tmp/dev.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/dev.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/dev.err', 'utf8') }
  }

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
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false

    original = kernel.devices.get('battery')!.device
  })

  it('/bin/devcli exists and /dev/battery is still its own file', async () => {
    expect(await kernel.filesystem.fs.exists('/bin/devcli')).toBe(true)
    expect(await kernel.filesystem.fs.exists('/dev/battery')).toBe(true)
  })

  it('runs the cli with its args, the live kernel and shell, and carries terminal output to stdout', async () => {
    useCli(async options => {
      seen = options
      options.terminal.writeln(`args=${options.args.join(',')}`)
      options.terminal.write('no newline')
      return 0
    })
    const { code, out } = await run('/dev/battery status now')
    expect(code).toBe(0)
    expect(out).toBe('args=status,now\nno newline')
    expect(seen?.kernel).toBe(kernel)
    expect(seen?.shell).toBe(kernel.shell)
    expect(seen?.pid).toBeGreaterThan(0)
  })

  it('works in a pipeline', async () => {
    useCli(async ({ terminal }) => { terminal.writeln('b'); terminal.writeln('a'); return 0 })
    const code = await kernel.shell.execute('/dev/battery | sort > /tmp/dev-sorted.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/dev-sorted.out', 'utf8')).toBe('a\nb\n')
  })

  it("the cli's number is the exit code (negatives become 1)", async () => {
    useCli(async () => 7)
    expect((await run('/dev/battery')).code).toBe(7)
    useCli(async () => -2)
    expect((await run('/dev/battery')).code).toBe(1)
    useCli(async () => undefined as never)
    expect((await run('/dev/battery')).code).toBe(0)
  })

  it('a cli that throws reports the error and exits 1', async () => {
    useCli(async () => { throw new Error('no antenna') })
    const { code, out } = await run('/dev/battery')
    expect(code).toBe(1)
    expect(out).toContain('battery: no antenna')
  })

  it('output produced after the cli returned (a watch callback) lands on the live terminal', async () => {
    let late: (() => void) | undefined
    useCli(async ({ terminal }) => { terminal.writeln('started'); late = () => terminal.writeln('later'); return 0 })
    const write = vi.spyOn(kernel.terminal, 'write')
    const { out } = await run('/dev/battery')
    expect(out).toBe('started\n')
    late!()
    expect(write).toHaveBeenCalledWith('later\n')
    write.mockRestore()
  })

  it('other terminal members pass through to the live terminal', async () => {
    useCli(async ({ terminal }) => { terminal.writeln(`rows>0:${terminal.rows > 0}`); return 0 })
    expect((await run('/dev/battery')).out).toBe('rows>0:true\n')
  })

  it('an unknown device or one without a cli is not run', async () => {
    kernel.devices.set('battery', { ...kernel.devices.get('battery')!, device: { ...original, cli: undefined } })
    const code = await kernel.shell.execute('/dev/battery > /tmp/dev.out 2> /tmp/dev.err')
    expect(code).not.toBe(0)
  })
})
