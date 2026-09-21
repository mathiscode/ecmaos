/**
 * Metadata only -- `format`'s real implementation is `core/kernel/src/bin/commands/format.mjs`, a
 * real, worker-hosted program running via `execve` reaching the permission check, the interactive
 * confirmation prompt, and the actual `indexedDB`/`localStorage` wipe through the new `system_format`
 * custom syscall (`core/kernel/src/tree/lib/main-thread-syscalls.ts`), migrated in this session's M1
 * pass. It lives in `@ecmaos/kernel`, not here, for the same reason `tty.ts`/`sockets.ts`/`user.ts`/
 * `umount.ts`/`theme.ts`/`history.ts` do -- see any of their doc comments, or `echo.ts`'s for the
 * general explanation of why this file is metadata-only.
 */
export const meta = { command: 'format', description: 'Delete all IndexedDB and localStorage data' } as const
