/**
 * Metadata only -- `nc`'s real implementation is `core/kernel/src/bin/commands/nc.mjs`, a real,
 * worker-hosted program running via `execve`. It lives in the kernel (like `sockets`) because a
 * connection is a live main-thread object; the program reaches it through `sockets_connect`, which
 * installs the socket as two real file descriptors. `meta` is all a `kind: 'execve'` manifest entry uses.
 */
export const meta = { command: 'nc', description: 'Netcat - network utility for reading from and writing to network connections' } as const
