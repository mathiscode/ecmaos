/**
 * Metadata only -- `view`'s real implementation is `core/kernel/src/bin/commands/view.mjs`, a
 * real, worker-hosted program running via `execve`. Showing each file is the `document` presenter,
 * which the program invokes through `window_present`. `meta` is all a `kind: 'execve'` manifest
 * entry uses.
 */
export const meta = { command: 'view', description: 'View files in a new window (PDF, images, audio, video)' } as const
