/**
 * Real `execve`'d `clear` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/kernel/src/tree/lib/commands/index.ts`). Portable with zero new kernel surface: clearing
 * the screen is exactly the ANSI escape `\x1b[2J\x1b[H` written to stdout, no kernel-only state
 * needed at all.
 */

const { exit, write } = globalThis.ecmaosSyscalls

try {
  write(1, new TextEncoder().encode('\x1b[2J\x1b[H'))
  exit(0)
} catch (error) {
  write(2, new TextEncoder().encode(`clear: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
