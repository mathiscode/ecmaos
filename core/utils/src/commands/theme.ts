/**
 * Metadata only -- `theme`'s real implementation is `core/kernel/src/bin/commands/theme.mjs`. It
 * lives in `@ecmaos/kernel`, not here, because it reaches live `Shell`/`Terminal` state, which a
 * worker can't see directly. See `echo.ts`'s doc comment for why this file itself is metadata-only.
 */
export const meta = { command: 'theme', description: 'List or switch themes' } as const
