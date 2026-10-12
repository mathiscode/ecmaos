import { bench, describe } from 'vitest'

import { Kernel } from '#kernel.ts'

describe('Kernel', () => {
  let kernel: Kernel

  bench('Boot kernel', async () => {
    kernel = new Kernel({ dom: { topbar: false }, log: false })
    await kernel.boot({ silent: true })
  })

  // The boot benchmark fails with "Size mismatch in buffer" in zenfs.

  bench('Execute command', async () => {
    await kernel.execute({ command: '/bin/echo', shell: kernel.shell })
  })
})
