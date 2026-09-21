/**
 * Metadata only -- `user`'s real implementation is `core/kernel/src/bin/commands/user.mjs`, a real,
 * worker-hosted program running via `execve` reaching `kernel.users`, the `suid !== 0` permission
 * check, and the interactive password prompt through the new `users_manage` custom syscall
 * (`core/kernel/src/tree/lib/main-thread-syscalls.ts`), migrated in this session's M1 pass. It lives
 * in `@ecmaos/kernel`, not here, for the same reason `tty.ts`/`sockets.ts` do -- see either file's
 * doc comment, or `echo.ts`'s for the general explanation of why this file is metadata-only.
 */
export const meta = { command: 'user', description: 'Manage users on the system' } as const
