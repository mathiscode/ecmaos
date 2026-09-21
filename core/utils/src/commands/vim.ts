/**
 * Metadata only -- `vim`'s real implementation is `core/kernel/src/bin/commands/vim.mjs`, a real,
 * worker-hosted program running via `execve`. The editor window (vim.wasm) is the `editor`
 * presenter, which holds the program until it exits. `meta` is all a `kind: 'execve'` manifest
 * entry uses.
 */
export const meta = { command: 'vim', description: 'Vi IMproved - a text editor' } as const
