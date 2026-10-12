import type { KernelCharDevice, KernelContext } from '@ecmaos/types'

export const pkg = {
  name: 'tty',
  version: '0.2.0',
  description: 'TTY pseudo-devices for /dev/ttyN'
}

/**
 * Registers nothing: TTY nodes are `/dev/xterm<n>`, registered by `attach_xterm` through `@zenfs/linux`'s
 * `TTYDriver`. Kept as a no-op because `DefaultDevices` still names this package.
 */
/**
 * Pseudo-terminals (`/dev/ptmx`, `/dev/pts/<n>`) are not registered here either: allocating a pair
 * per `open` needs a syscall hook, so they live in the kernel (`lib/pty.ts`).
 */
export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  return []
}
