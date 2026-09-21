/**
 * Metadata only -- `tty`'s real implementation is `core/kernel/src/bin/commands/tty.mjs`, a real,
 * worker-hosted program running via `execve` reaching `kernel.activeTty`/`kernel.switchTty()`
 * through the `tty_get`/`tty_switch` custom syscalls (`core/kernel/src/tree/lib/main-thread-
 * syscalls.ts`), migrated in this session's M1 pass. It lives in `@ecmaos/kernel`, not here (unlike
 * most migrated commands), because its real logic needs kernel-only state a worker can't see
 * directly -- the same reasoning `core/kernel/src/bin/commands`'s own doc comment
 * gives for `clear`/`df`/`ps`/`reboot`, which moved there the same way. See `echo.ts`'s doc comment
 * for the general explanation of why this file itself is metadata-only.
 */
export const meta = { command: 'tty', description: 'Print the current TTY number or switch to a different TTY' } as const
