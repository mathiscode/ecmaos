/**
 * Metadata only -- `man`'s real implementation is `core/utils/src/commands-execve/man.mjs`, a
 * real, worker-hosted program running via `execve` that pages with the shared raw-mode pager.
 * `meta` is all a `kind: 'execve'` manifest entry uses.
 */
export const meta = { command: 'man', description: 'Display manual pages' } as const
