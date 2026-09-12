/**
 * Pilot: a real, worker-hosted program that reaches a main-thread-only capability (creating a real
 * DOM window) through a real custom syscall, proving `main-thread-syscalls.ts`'s design end to end --
 * not just that `define_syscall` accepts a handler, but that a worker-hosted program can call it,
 * get a real handle back, and use it, exactly the way `pilot-pwd.mjs` proved real stdio syscalls.
 *
 * `window_create`/`window_write`/`window_close` are not part of `globalThis.ecmaosSyscalls`'s fixed
 * `open`/`read`/`write`/... set (see `/bin/node.mjs`'s own doc comment) -- they're ecmaOS's own
 * syscalls, reached through `custom` (`syscall_async`), the non-blocking calling convention. See
 * `main-thread-syscalls.ts`'s doc comment for why `syscall_async`, not the sync `Atomics.wait` path.
 */

const { exit, write, custom } = globalThis.ecmaosSyscalls

try {
  const handle = await custom('window_create', 'pilot-window')
  await custom('window_write', handle, 'hello from a real worker\n')
  await custom('window_close', handle)
  write(1, new TextEncoder().encode(`${handle}\n`))
  exit(0)
} catch (error) {
  write(2, new TextEncoder().encode(`pilot-window: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
