/**
 * Metadata only -- `set` is a true shell builtin (mutates the calling shell's own execution
 * options). Its real implementation is `core/kernel/src/tree/lib/shell-builtins.ts`. See `cd.ts`'s
 * doc comment for the full explanation of why true builtins are permanent, not migration-pending.
 */
export const meta = { command: 'set', description: 'Configure shell options (-e, -u, -o pipefail)' } as const
