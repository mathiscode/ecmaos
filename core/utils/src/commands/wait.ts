/**
 * Metadata only -- `wait` is a true shell builtin (waits on the calling shell's own job table).
 * Its real implementation is `core/kernel/src/tree/lib/shell-builtins.ts`. See `cd.ts`'s doc
 * comment for the full explanation of why true builtins are permanent, not migration-pending.
 */
export const meta = { command: 'wait', description: 'Wait for background job(s) to finish' } as const
