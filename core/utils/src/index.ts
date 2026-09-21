// Export shared infrastructure
export { TerminalCommand } from './shared/terminal-command.js'
export { writeStdout, writelnStdout, writeStderr, writelnStderr } from './shared/helpers.js'
export type { CommandArgs } from './shared/command-args.js'

// The legacy-command shim -- see legacy-command-shim.ts's own doc comment for why this replaced
// the old eager createAllCommands/TerminalCommands (deleted here; its only consumers, kernel.ts's
// registerCommands/executeCommand and terminal.ts's tab-completion, all moved off it).
export { getLegacyCommands, resolveLegacyCommand } from './shared/legacy-command-shim.js'
export type { LegacyCommands, LegacyCommandEntry, CreateCommandFn } from './shared/legacy-command-shim.js'

// Export individual command factories -- excludes the 77 execve-migrated names (echo, basename,
// dirname, tr, mkdir, rm, cp, mv, touch, chmod, cat, head, tail, wc, nl, rev, tac, uniq, cut, fold,
// expand, unexpand, cksum, strings, xxd, od, hash, cmp, comm, column, seq, factor, rmdir, join,
// paste, sleep, mktemp, shuf, split, pr, tee, stat, readlink, realpath, ln, dd, sort, find, diff,
// grep, sed, awk, ls, tar, cal, date, printf, which, whoami, pwd, hostname,
// uname, nproc, uptime, motd, fmt, crypto, curl, fetch, id, groups, chown, zip, unzip, git, less, man) and the 8 true shell builtins now living in
// core/kernel/src/tree/lib/shell-builtins.ts (cd, set, bg, fg, jobs, wait, local, env) -- neither
// has a createCommand anymore, only meta (see their files). test/true/false stay on the legacy
// in-process shim deliberately -- migrating them to real execve made a tight shell while-loop using
// `test` as its condition measurably slower (each iteration now pays a real worker spin-up instead
// of an in-process call), a real perf regression for the pattern these three are most used in.
export { createCommand as createFalse } from './commands/false.js'
export { createCommand as createMount } from './commands/mount.js'
export { createCommand as createPasskey } from './commands/passkey.js'
export { createCommand as createScreensaverDaemon } from './commands/screensaver-daemon.js'
export { createCommand as createTest } from './commands/test.js'
export { createCommand as createTrue } from './commands/true.js'
