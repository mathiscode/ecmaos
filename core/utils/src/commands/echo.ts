/**
 * Metadata only -- `echo`'s real implementation is `core/utils/src/commands-execve/echo.mjs`.
 * `meta` is all a `kind: 'execve'` manifest entry needs; nothing else references this file.
 */
export const meta = { command: 'echo', description: 'Print arguments to the standard output' } as const
