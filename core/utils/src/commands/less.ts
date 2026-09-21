/**
 * Metadata only -- `less`'s real implementation is `core/utils/src/commands-execve/less.mjs`,
 * a real, worker-hosted program running via `execve` that pages through the real `@zenfs/linux`
 * line discipline in raw mode. `meta` is all a `kind: 'execve'` manifest entry uses.
 */
export const meta = { command: 'less', description: 'View file contents interactively' } as const
