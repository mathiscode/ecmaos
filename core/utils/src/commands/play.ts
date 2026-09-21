/**
 * Metadata only -- `play`'s real implementation is `core/kernel/src/bin/commands/play.mjs`, a
 * real, worker-hosted program running via `execve`. The DOM half is the `audio` presenter (a player window, or none with `--quiet`),
 * which the program invokes through `window_present`. `meta` is all a `kind: 'execve'` manifest
 * entry uses.
 */
export const meta = { command: 'play', description: 'Play an audio file' } as const
