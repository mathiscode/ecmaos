/**
 * Pilot: a worker-hosted program that creates a DOM window through the custom syscalls `window_create`,
 * `window_write` and `window_close`, reached with `custom` (`syscall_async`). Exercises `main-thread-syscalls.ts` end
 * to end.
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
