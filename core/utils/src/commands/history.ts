/**
 * Metadata only -- `history`'s real implementation is `core/kernel/src/bin/commands/history.mjs`.
 * It lives in `@ecmaos/kernel`, not here, because it reaches the live in-memory `Terminal` history
 * buffer, kernel-only state a worker can't see directly. See `echo.ts`'s doc comment for why this
 * file itself is metadata-only.
 */
export const meta = { command: 'history', description: 'Display or manipulate the command history' } as const
