/**
 * Metadata only -- `format`'s real implementation is `core/kernel/src/bin/commands/format.mjs`. It
 * lives in `@ecmaos/kernel`, not here, because the interactive confirmation prompt and the actual
 * `indexedDB`/`localStorage` wipe both need kernel-only state a worker can't see directly. See
 * `echo.ts`'s doc comment for why this file itself is metadata-only.
 */
export const meta = { command: 'format', description: 'Delete all IndexedDB and localStorage data' } as const
