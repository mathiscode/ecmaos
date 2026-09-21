/**
 * Metadata only -- `video`'s real implementation is `core/kernel/src/bin/commands/video.mjs`, a
 * real, worker-hosted program running via `execve`. The DOM half is the `video` presenter (a window with a `<video>`),
 * which the program invokes through `window_present`. `meta` is all a `kind: 'execve'` manifest
 * entry uses.
 */
export const meta = { command: 'video', description: 'Play a video file' } as const
