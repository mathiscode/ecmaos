import type { KernelCharDevice, KernelContext } from '@ecmaos/types'

export const pkg = {
  name: 'tty',
  version: '0.2.0',
  description: 'TTY pseudo-devices for /dev/ttyN'
}

/**
 * No longer registers anything.
 *
 * ecmaOS's TTY nodes are real ones now: `attach_xterm` (from `@zenfs/linux`, wired in
 * `Terminal.mount()`) registers `/dev/xterm<n>` through `@zenfs/linux`'s own `TTYDriver` — with a
 * real line discipline, termios, and `major: 4` (the real Linux tty major) — which is exactly what
 * this package's old `getDrivers()` was approximating by hand with `/dev/tty0`-`/dev/tty9` char
 * devices sharing that same major. Kept as an empty, documented no-op rather than removed outright,
 * since `DefaultDevices` still names this package.
 */
export async function getDrivers(_ctx: KernelContext): Promise<KernelCharDevice[]> {
  return []
}
