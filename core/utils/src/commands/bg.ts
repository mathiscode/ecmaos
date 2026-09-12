/**
 * Metadata only -- `bg` is a true shell builtin (mutates the calling shell's own job table). Its
 * real implementation is `core/kernel/src/tree/lib/shell-builtins.ts`. See `cd.ts`'s doc comment
 * for the full explanation of why true builtins are permanent, not migration-pending.
 */
export const meta = { command: 'bg', description: 'Resume a stopped job in the background' } as const
