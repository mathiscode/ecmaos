/**
 * Metadata only -- `cron`'s real implementation is `core/kernel/src/bin/commands/cron.mjs`, a real,
 * worker-hosted program running via `execve`. It's paired with `core/kernel/src/bin/commands/crond.mjs`,
 * the real scheduler daemon (started from `/boot/init`) that replaced `kernel.intervals`'s old
 * closure-based cron registry entirely -- see either file's own doc comment. This command lives in
 * `@ecmaos/kernel`, not here, for the same reason `tty.ts`/`sockets.ts`/`user.ts`/`umount.ts`/
 * `theme.ts` do -- see any of their doc comments, or `echo.ts`'s for the general explanation of why
 * this file is metadata-only.
 */
export const meta = { command: 'cron', description: 'Manage scheduled tasks (crontabs)' } as const
