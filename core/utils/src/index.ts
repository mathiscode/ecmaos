// Export shared infrastructure
export { TerminalCommand } from './shared/terminal-command.js'
export { writeStdout, writelnStdout, writeStderr, writelnStderr } from './shared/helpers.js'
export type { CommandArgs } from './shared/command-args.js'

// The in-process command shim - see legacy-command-shim.ts's own doc comment for what it covers
// and why. Its only consumers are kernel.ts's registerCommands/executeCommand and terminal.ts's
// tab-completion.
export { getLegacyCommands, resolveLegacyCommand } from './shared/legacy-command-shim.js'
export type { LegacyCommands, LegacyCommandEntry, CreateCommandFn } from './shared/legacy-command-shim.js'

// Exports the command factories that still run in-process: `true`, `false` and `test`, which stay in-process because
// a worker start-up per loop iteration is slow. Every other command is an `execve` program, and the shell builtins
// live in `core/kernel/src/tree/lib/shell-builtins.ts`.
export { createCommand as createFalse } from './commands/false.js'
export { createCommand as createTest } from './commands/test.js'
export { createCommand as createTrue } from './commands/true.js'
