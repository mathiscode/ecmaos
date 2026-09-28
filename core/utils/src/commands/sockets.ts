/**
 * Metadata only -- `sockets`' real implementation is `core/kernel/src/bin/commands/sockets.mjs`. It
 * lives in `@ecmaos/kernel`, not here, because it reaches `kernel.sockets`, kernel-only state a
 * worker can't see directly. See `echo.ts`'s doc comment for why this file itself is metadata-only.
 */
export const meta = { command: 'sockets', description: 'Manage socket connections (WebSocket and WebTransport)' } as const
