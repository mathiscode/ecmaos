/**
 * Metadata only -- `umount`'s real implementation is `core/kernel/src/bin/commands/umount.mjs`, a
 * real, worker-hosted program running via `execve` reaching `kernel.filesystem.mounts`/
 * `kernel.filesystem.fsSync.umount()` through the new `fs_umount` custom syscall
 * (`core/kernel/src/tree/lib/main-thread-syscalls.ts`), migrated in this session's M1 pass. It lives
 * in `@ecmaos/kernel`, not here, for the same reason `tty.ts`/`sockets.ts`/`user.ts` do -- see any of
 * their doc comments, or `echo.ts`'s for the general explanation of why this file is metadata-only.
 */
export const meta = { command: 'umount', description: 'Unmount a filesystem' } as const
