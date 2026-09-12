/**
 * Metadata only -- `local` is a true shell builtin (mutates the calling shell's own call-frame
 * scope). Its real implementation is `core/kernel/src/tree/lib/shell-builtins.ts`. See `cd.ts`'s
 * doc comment for the full explanation of why true builtins are permanent, not migration-pending.
 */
export const meta = { command: 'local', description: 'Declare a variable local to the current function call' } as const
