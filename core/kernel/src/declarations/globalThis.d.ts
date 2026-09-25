import type { Kernel, Shell, Terminal } from '@ecmaos/types'

declare global {
  var kernel: Kernel | undefined
  var kernels: Map<string, Kernel> | undefined
  var shells: Map<string, Shell> | undefined
  var terminals: Map<string, Terminal> | undefined
  var requiremap: Map<string, {
    command: string
    code: string
    filePath: string
    binLink: string
    argv: string[]
    argv0: string
  }> | undefined
}

export type Timer = ReturnType<typeof setInterval>
