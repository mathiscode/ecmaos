/**
 * Metadata only -- `env` (as implemented here, splicing then delegating to `shell.execute`) is a
 * true shell builtin (mutates the calling shell's own environment). Its real implementation is
 * `core/kernel/src/tree/lib/shell-builtins.ts`. See `cd.ts`'s doc comment for the full explanation
 * of why true builtins are permanent, not migration-pending.
 */
export const meta = { command: 'env', description: 'Run a program in a modified environment' } as const
