/**
 * Metadata only -- `tee`'s real implementation is `core/utils/src/commands-execve/tee.mjs`,
 * a real, worker-hosted program running via `execve` (see `feat/1.0.0-execve-commands`). This
 * file's `createCommand`/in-process `run` was deleted once the command-manifest registry
 * (`feat/1.0.0-command-manifest`) stopped needing it: `meta` is all a `kind: 'execve'` manifest
 * entry uses, and nothing else references this file anymore.
 */
export const meta = { command: 'tee', description: 'Read from standard input and write to standard output and files' } as const
