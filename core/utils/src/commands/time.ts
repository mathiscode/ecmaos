/**
 * Metadata only -- `time`'s real implementation is `core/kernel/src/bin/commands/time.mjs`. It
 * lives in `@ecmaos/kernel`, not here, for the same reason `tty.ts`/`sockets.ts`/`user.ts`/
 * `history.ts` do -- see any of their doc comments, or `echo.ts`'s.
 */
export const meta = { command: 'time', description: 'Measure command execution time' } as const
