import type { ModuleContext } from '@ecmaos/types'

/**
 * Runs when the module is loaded (`insmod`, or `modprobe boilerplate`). `ctx` is everything the module may use of the
 * kernel; whatever it adds (files in /proc, a command, a filesystem type) is taken away again when the module unloads.
 */
export default {
  init(ctx: ModuleContext) {
    ctx.log.info('boilerplate is loaded')
    ctx.proc('boilerplate', { show: () => 'hello from boilerplate\n' })
  },

  exit() {}
}
