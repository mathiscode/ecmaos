/**
 * Metadata only -- `passkey`'s real implementation is `core/kernel/src/bin/commands/passkey.mjs`, a real,
 * worker-hosted program running via `execve`; WebAuthn only exists in the top-level browsing context, so the work runs behind the `auth_passkey` custom syscall (`#lib/passkey-manage.ts`).
 * See `umount.ts` for the general explanation of why this file is metadata-only.
 */
export const meta = { command: 'passkey', description: 'Manage passkey credentials for WebAuthn authentication' } as const
