/**
 * Metadata only -- `mount`'s real implementation is `core/kernel/src/bin/commands/mount.mjs`, a real,
 * worker-hosted program running via `execve`; the backends (browser storage, File System Access picker, Google Drive OAuth) run main-thread side behind the `fs_mount` custom syscall (`#lib/mount-backends.ts`).
 * See `umount.ts` for the general explanation of why this file is metadata-only.
 */
export const meta = { command: 'mount', description: 'Mount a filesystem' } as const
