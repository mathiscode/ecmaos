/**
 * Metadata only -- `theme`'s real implementation is `core/kernel/src/bin/commands/theme.mjs`, a
 * real, worker-hosted program running via `execve` reaching `shell.config.setTheme()` through the
 * new `shell_set_theme` custom syscall (`core/kernel/src/tree/lib/main-thread-syscalls.ts`),
 * migrated in this session's M1 pass. It lives in `@ecmaos/kernel`, not here, for the same reason
 * `tty.ts`/`sockets.ts`/`user.ts`/`umount.ts` do -- see any of their doc comments, or `echo.ts`'s
 * for the general explanation of why this file is metadata-only.
 */
export const meta = { command: 'theme', description: 'List or switch themes' } as const
