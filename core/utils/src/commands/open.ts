/**
 * Metadata only -- `open`'s real implementation is `core/kernel/src/bin/commands/open.mjs`, a
 * real, worker-hosted program running via `execve`. The DOM half (a new tab, a download) is a
 * presenter the program invokes through `window_present`. `meta` is all a `kind: 'execve'`
 * manifest entry uses.
 */
export const meta = { command: 'open', description: 'Open a file or URL' } as const
