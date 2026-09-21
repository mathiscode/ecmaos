/**
 * Metadata only -- `screensaver-daemon`'s real implementation is `core/kernel/src/bin/commands/screensaver-daemon.mjs`, a real,
 * worker-hosted program running via `execve`; starting the daemon registers global DOM listeners, done by the `screensaver_start` custom syscall.
 * See `umount.ts` for the general explanation of why this file is metadata-only.
 */
export const meta = { command: 'screensaver-daemon', description: 'Start the idle-timeout screensaver daemon' } as const
