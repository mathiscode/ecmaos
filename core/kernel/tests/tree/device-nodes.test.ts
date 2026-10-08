import { beforeAll, describe, expect, it } from 'vitest'

import type { KernelDevice } from '@ecmaos/types'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Drivers that ask for major 0 each get a dynamic major of their own. They used to share one, and the kernel finds a driver
 * by minor alone, so two packages numbering their nodes from 1 answered each other's opens.
 */
describe('device nodes of drivers with a dynamic major', () => {
  let kernel: Kernel
  const driversOf = (name: string) => kernel.devices.get(name)!.drivers

  beforeAll(async () => {
    const pad: KernelDevice = (await import('@ecmaos-devices/gamepad')) as KernelDevice
    const other = await import('@ecmaos-devices/serial')
    const fakeSerial: KernelDevice = {
      ...(other as unknown as KernelDevice),
      getDrivers: async ctx => (await (other as unknown as KernelDevice).getDrivers(ctx)).concat([{ name: 'ttyFake', major: 0, minor: 1, class: undefined as never, ops: { read: () => 0, write: () => {} } }])
    }
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      devices: { gamepad: pad, serial: fakeSerial }
    })
    Object.defineProperty(globalThis.navigator, 'getGamepads', { value: () => [], configurable: true })
    await kernel.boot()
  })

  it('makes a js<N> node for each pad slot next to the /dev/gamepad entry', async () => {
    expect(driversOf('gamepad').map(driver => driver.name)).toEqual(['gamepad', 'js0', 'js1', 'js2', 'js3'])
    for (const name of ['gamepad', 'js0', 'js3']) expect(await kernel.filesystem.fs.exists(`/dev/${name}`)).toBe(true)
  })

  it('gives each package its own dynamic major, although both use minor 1', async () => {
    const rdev = async (path: string) => (await kernel.filesystem.fs.stat(path) as unknown as { rdev: number | bigint }).rdev
    const pad = BigInt(await rdev('/dev/js0'))
    const fake = BigInt(await rdev('/dev/ttyFake'))
    // major in the high bits, minor in the low 20
    expect(pad & 0xfffffn).toBe(1n)
    expect(fake & 0xfffffn).toBe(1n)
    expect(pad >> 20n).not.toBe(fake >> 20n)
  })
})
