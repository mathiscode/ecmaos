/**
 * Metadata only -- `fmt`'s real implementation is `core/utils/src/commands-execve/fmt.mjs`,
 * a real, worker-hosted program running via `execve` (see `feat/1.0.0-execve-commands`). This
 * file's `createCommand`/in-process `run` was deleted once the command-manifest registry
 * (`feat/1.0.0-command-manifest`) stopped needing it: `meta` is all a `kind: 'execve'` manifest
 * entry uses, and nothing else references this file anymore.
 */
export const meta = { command: 'fmt', description: 'Reformat paragraph text' } as const
