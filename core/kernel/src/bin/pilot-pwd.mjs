/**
 * Pilot (test fixture): a minimal worker-hosted program that calls `getcwd()` and writes the result to fd 1,
 * exercising `execve` and redirected stdout with real syscalls only. It imports nothing from `@zenfs/linux/uapi/*`;
 * `/bin/node` exposes the initialized wrappers on `globalThis.ecmaosSyscalls`.
 */

const { getcwd, write, exit } = globalThis.ecmaosSyscalls

try {
  const cwd = getcwd()
  write(1, new TextEncoder().encode(cwd + '\n'))
  exit(0)
} catch (error) {
  write(2, new TextEncoder().encode(`pilot-pwd: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
