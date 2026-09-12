/**
 * Metadata only -- `cd` is a true shell builtin (mutates the calling shell's own `cwd`, which a
 * separate `execve`'d process can never do to its parent, the same reason bash keeps `cd` a
 * permanent special builtin). Its real implementation is
 * `core/kernel/src/tree/lib/shell-builtins.ts`, dispatched directly by `Shell.execute` before any
 * file-based command resolution happens at all. This file's `createCommand`/`TerminalCommand`
 * body was deleted once nothing referenced it anymore.
 */
export const meta = { command: 'cd', description: 'Change the shell working directory' } as const
