import { InMemory } from '@zenfs/core'
import { Kernel } from '@ecmaos/kernel'
import type { Process } from '@ecmaos/types'

import '@ecmaos/kernel/ui.css'
import main from './main.ts'

declare global {
  var kernel: Kernel | undefined // eslint-disable-line no-var
}

const kernel = globalThis.kernel = new Kernel({
  credentials: { username: 'root', password: 'root' },
  filesystem: {
    mounts: {
      // @ts-expect-error - InMemory is passed as a backend class here
      '/': InMemory
    }
  }
})

kernel.terminal.mount(document.getElementById('terminal')!)
await kernel.boot({ silent: true })

// A plain stand-in for `ProcessEntryParams.instance`; this harness calls `main()` with no process behind it.
const instance = {
  args: ['/bin/ls'],
  command: '/usr/bin/code',
  cwd: '/tmp',
  gid: 0,
  kernel,
  pid: 1,
  shell: kernel.shell,
  terminal: kernel.terminal,
  uid: 0
} as unknown as Process

const params = {
  args: ['/tmp/test.js'],
  command: '/usr/bin/code',
  cwd: '/tmp',
  gid: 0,
  instance,
  kernel,
  pid: 1,
  shell: kernel.shell,
  terminal: kernel.terminal,
  uid: 0
}

main(params)
