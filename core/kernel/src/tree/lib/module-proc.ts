/** The module entries of `/proc`: `modules` (with the size of each file, which `lsmod` shows), `kallsyms`, and `sys/kernel/tainted` and `modules_disabled` */

import { modules } from '@zenfs/linux'
import { ProcDir } from '@zenfs/linux/fs/procfs'

import type { ModuleManager } from './kmodule.ts'

export function registerModuleProc(root: ProcDir, kmodules: ModuleManager): void {
  // @zenfs/linux's file with the size filled in; the load address means nothing here and stays 0
  root.children.set('modules', {
    mode: 0o444,
    show: () => [...modules.values()].map(mod => {
      const holders = mod.holders.size ? [...mod.holders].map(holder => holder.name).join(',') + ',' : '-'
      const state = mod.state === 'live' ? 'Live' : mod.state === 'init' ? 'Loading' : 'Unloading'
      return `${mod.name} ${kmodules.size(mod.name)} ${mod.refcnt} ${holders} ${state} 0x0000000000000000${mod.flags ? ` (${mod.flags})` : ''}\n`
    }).join('')
  })

  root.children.set('kallsyms', {
    mode: 0o444,
    show: () => kmodules.symbols().map(({ symbol, module }) => `0000000000000000 T ${symbol}\t[${module}]`).join('\n') + (kmodules.symbols().length ? '\n' : '')
  })

  const kernel = root.lookup('sys')
  const dir = kernel instanceof ProcDir ? kernel.lookup('kernel') : undefined
  if (!(dir instanceof ProcDir)) return
  dir.children.set('tainted', { mode: 0o444, show: () => `${kmodules.tainted}\n` })
  // one-way, as on Linux: writing 1 stops loading and unloading until reboot, and a 0 does not undo it
  dir.children.set('modules_disabled', {
    mode: 0o644,
    show: () => `${kmodules.disabled ? 1 : 0}\n`,
    store: (value: string) => {
      if (value.trim() === '1') kmodules.disable()
      else if (kmodules.disabled) throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
    }
  })
}
