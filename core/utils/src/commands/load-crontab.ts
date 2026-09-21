/**
 * Metadata only -- `load-crontab`'s real implementation is
 * `core/kernel/src/bin/commands/load-crontab.mjs`, a real, worker-hosted program running via
 * `execve` reaching `kernel.loadCrontab()` through the new `crontab_load` custom syscall
 * (`core/kernel/src/tree/lib/main-thread-syscalls.ts`), migrated in this session's M1 pass. It lives
 * in `@ecmaos/kernel`, not here, for the same reason `tty.ts`/`sockets.ts`/`user.ts`/`umount.ts`/
 * `theme.ts` do -- see any of their doc comments, or `echo.ts`'s for the general explanation of why
 * this file is metadata-only.
 */
export const meta = { command: 'load-crontab', description: 'Load and register crontab entries from a file' } as const
