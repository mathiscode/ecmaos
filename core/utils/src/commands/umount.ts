/**
 * Metadata only -- `umount`'s real implementation is `core/kernel/src/bin/commands/umount.mjs`. It
 * lives in `@ecmaos/kernel`, not here, because it reaches `kernel.filesystem.mounts`, kernel-only
 * state a worker can't see directly. See `echo.ts`'s doc comment for why this file itself is
 * metadata-only.
 */
export const meta = { command: 'umount', description: 'Unmount a filesystem' } as const
