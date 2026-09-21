/**
 * Metadata only -- `web`'s real implementation is `core/kernel/src/bin/commands/web.mjs`, a real,
 * worker-hosted program running via `execve`. The contained browser window is the `browser`
 * presenter, which the program invokes through `window_present`. `meta` is all a
 * `kind: 'execve'` manifest entry uses.
 */
export const meta = { command: 'web', description: 'Open a URL in a browser window' } as const
