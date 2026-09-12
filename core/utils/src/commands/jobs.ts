/**
 * Metadata only -- `jobs` is a true shell builtin (reads the calling shell's own live, in-process
 * job table). Its real implementation is `core/kernel/src/tree/lib/shell-builtins.ts`. See
 * `cd.ts`'s doc comment for the full explanation of why true builtins are permanent, not
 * migration-pending.
 */
export const meta = { command: 'jobs', description: "List the shell's tracked jobs" } as const
