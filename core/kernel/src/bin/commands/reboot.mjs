/**
 * Real `execve`'d `reboot` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/kernel/src/tree/lib/commands/index.ts`). `kernel.reboot()` shuts down every subsystem then
 * calls `globalThis.location.reload()`, which doesn't exist inside a Web Worker -- reached through
 * the `reboot` custom syscall (`#lib/main-thread-syscalls.ts`) the same way `window_create` reaches
 * main-thread-only DOM APIs.
 */

const { exit, write, custom } = globalThis.ecmaosSyscalls

try {
  await custom('reboot')
  exit(0)
} catch (error) {
  write(2, new TextEncoder().encode(`reboot: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
