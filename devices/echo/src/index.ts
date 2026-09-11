import { Class } from '@zenfs/linux'
import type { KernelCharDevice, KernelContext, KernelDeviceCLIOptions } from '@ecmaos/types'

export const pkg = {
  name: 'echo',
  version: '0.1.0',
  description: ''
}

export async function cli(options: KernelDeviceCLIOptions) {
  options.kernel.log.debug(`${pkg.name} CLI`, options.args)
  return 0
}

/** `/sys/class/echo` */
const echo_class = new Class('echo')

export async function getDrivers(ctx: KernelContext): Promise<KernelCharDevice[]> {
  return [{
    name: 'echo',
    major: 5,
    minor: 1,
    class: echo_class,
    ops: {
      read: () => 0,
      write: (file, buffer, offset) => {
        const text = new TextDecoder().decode(buffer.subarray(offset))
        ctx.log.debug(`[echo:${ctx.id}] ${text}`)
      }
    }
  }]
}
