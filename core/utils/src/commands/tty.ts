/**
 * Metadata only -- `tty`'s real implementation is `core/kernel/src/bin/commands/tty.mjs`. It lives
 * in `@ecmaos/kernel`, not here, because it reaches `kernel.activeTty`/`kernel.switchTty()`,
 * kernel-only state a worker can't see directly. See `echo.ts`'s doc comment for why this file
 * itself is metadata-only.
 */
export const meta = { command: 'tty', description: 'Print the current TTY number or switch to a different TTY' } as const
