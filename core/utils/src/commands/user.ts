/**
 * Metadata only -- `user`'s real implementation is `core/kernel/src/bin/commands/user.mjs`. It
 * lives in `@ecmaos/kernel`, not here, because it reaches `kernel.users`, kernel-only state a
 * worker can't see directly. See `echo.ts`'s doc comment for why this file itself is metadata-only.
 */
export const meta = { command: 'user', description: 'Manage users on the system' } as const
