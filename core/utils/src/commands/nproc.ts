/**
 * Metadata only -- `nproc`'s real implementation is `core/utils/src/commands-execve/nproc.mjs`,
 * a real, worker-hosted program running via `execve` (see `feat/1.0.0-execve-commands`). This
 * file's `createCommand`/in-process `run` was deleted once the command-manifest registry
 * (`feat/1.0.0-command-manifest`) stopped needing it: `meta` is all a `kind: 'execve'` manifest
 * entry uses, and nothing else references this file anymore.
 */
export const meta = { command: 'nproc', description: 'Print the number of processing units available' } as const
