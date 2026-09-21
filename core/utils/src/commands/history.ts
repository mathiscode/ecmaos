/**
 * Metadata only -- `history`'s real implementation is `core/kernel/src/bin/commands/history.mjs`, a
 * real, worker-hosted program running via `execve` reaching the live, in-memory `Terminal` history
 * buffer through the new `terminal_clear_history`/`terminal_reload_history` custom syscalls
 * (`core/kernel/src/tree/lib/main-thread-syscalls.ts`), migrated in this session's M1 pass. It lives
 * in `@ecmaos/kernel`, not here, for the same reason `tty.ts`/`sockets.ts`/`user.ts`/`umount.ts`/
 * `theme.ts` do -- see any of their doc comments, or `echo.ts`'s for the general explanation of why
 * this file is metadata-only.
 */
export const meta = { command: 'history', description: 'Display or manipulate the command history' } as const
