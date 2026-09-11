import type { DeviceDriver, Device } from '@zenfs/core'
import type { KernelContext, KernelDeviceCLIOptions, KernelDeviceData } from '@ecmaos/types'

export const pkg = {
  name: 'echo',
  version: '0.1.0',
  description: ''
}

export async function cli(options: KernelDeviceCLIOptions) {
  options.kernel.log.debug(`${pkg.name} CLI`, options.args)
  return 0
}

export async function getDrivers(ctx: KernelContext): Promise<DeviceDriver<KernelDeviceData>[]> {
  const drivers: DeviceDriver<KernelDeviceData>[] = [{
    name: 'echo',
    init: () => ({ major: 5, minor: 1, data: { kernelId: ctx.id } }),
    read: (_file: Device<KernelDeviceData>, _buffer: ArrayBufferView, _offset: number, _end: number) => 0,
    write: (file: Device<KernelDeviceData>, buffer: ArrayBufferView, offset: number) => {
      const length = buffer.byteLength - offset
      const data = buffer.buffer.slice(buffer.byteOffset + offset, buffer.byteOffset + offset + length)
      const text = new TextDecoder().decode(data)
      ctx.log.debug(`[echo:${file.data?.kernelId}] ${text}`)
      return length
    }
  }]

  return drivers
}
