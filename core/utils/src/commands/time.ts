/**
 * Metadata only -- `time`'s real implementation is `core/kernel/src/bin/commands/time.mjs`, a real,
 * worker-hosted program running via `execve` that times a child started with the `proc_spawn`/
 * `proc_wait` syscalls (falling back to `shell_exec` for legacy in-process commands and builtins),
 * migrated in this session's M1 pass. It lives in `@ecmaos/kernel`, not here, for the same reason
 * `tty.ts`/`sockets.ts`/`user.ts`/`history.ts` do -- see any of their doc comments, or `echo.ts`'s.
 */
export const meta = { command: 'time', description: 'Measure command execution time' } as const
