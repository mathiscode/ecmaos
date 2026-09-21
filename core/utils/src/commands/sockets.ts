/**
 * Metadata only -- `sockets`' real implementation is `core/kernel/src/bin/commands/sockets.mjs`, a
 * real, worker-hosted program running via `execve` reaching `kernel.sockets` through the
 * `sockets_list`/`sockets_create`/`sockets_close`/`sockets_show` custom syscalls (`core/kernel/src/
 * tree/lib/main-thread-syscalls.ts`), migrated in this session's M1 pass. It lives in
 * `@ecmaos/kernel`, not here, for the same reason `tty.ts` does -- see that file's doc comment, or
 * `echo.ts`'s for the general explanation of why this file is metadata-only.
 */
export const meta = { command: 'sockets', description: 'Manage socket connections (WebSocket and WebTransport)' } as const
