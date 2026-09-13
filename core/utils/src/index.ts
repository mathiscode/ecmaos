// Export shared infrastructure
export { TerminalCommand } from './shared/terminal-command.js'
export { writeStdout, writelnStdout, writeStderr, writelnStderr } from './shared/helpers.js'
export type { CommandArgs } from './shared/command-args.js'

// The legacy-command shim -- see legacy-command-shim.ts's own doc comment for why this replaced
// the old eager createAllCommands/TerminalCommands (deleted here; its only consumers, kernel.ts's
// registerCommands/executeCommand and terminal.ts's tab-completion, all moved off it).
export { getLegacyCommands, resolveLegacyCommand } from './shared/legacy-command-shim.js'
export type { LegacyCommands, LegacyCommandEntry, CreateCommandFn } from './shared/legacy-command-shim.js'

// Export individual command factories -- excludes the 72 execve-migrated names (echo, basename,
// dirname, tr, mkdir, rm, cp, mv, touch, chmod, cat, head, tail, wc, nl, rev, tac, uniq, cut, fold,
// expand, unexpand, cksum, strings, xxd, od, hash, cmp, comm, column, seq, factor, rmdir, join,
// paste, sleep, mktemp, shuf, split, pr, tee, stat, readlink, realpath, ln, dd, sort, find, diff,
// grep, sed, awk, ls, tar, cal, date, printf, which, whoami, pwd, hostname,
// uname, nproc, uptime, motd, fmt, crypto, curl, fetch, id, groups, chown) and the 8 true shell builtins now living in
// core/kernel/src/tree/lib/shell-builtins.ts (cd, set, bg, fg, jobs, wait, local, env) -- neither
// has a createCommand anymore, only meta (see their files). test/true/false stay on the legacy
// in-process shim deliberately -- migrating them to real execve made a tight shell while-loop using
// `test` as its condition measurably slower (each iteration now pays a real worker spin-up instead
// of an in-process call), a real perf regression for the pattern these three are most used in.
export { createCommand as createCron } from './commands/cron.js'
export { createCommand as createFalse } from './commands/false.js'
export { createCommand as createFormat } from './commands/format.js'
export { createCommand as createGit } from './commands/git.js'
export { createCommand as createHistory } from './commands/history.js'
export { createCommand as createLess } from './commands/less.js'
export { createCommand as createLoadCrontab } from './commands/load-crontab.js'
export { createCommand as createMan } from './commands/man.js'
export { createCommand as createMount } from './commands/mount.js'
export { createCommand as createNc } from './commands/nc.js'
export { createCommand as createOpen } from './commands/open.js'
export { createCommand as createPasskey } from './commands/passkey.js'
export { createCommand as createPlay } from './commands/play.js'
export { createCommand as createScreensaverDaemon } from './commands/screensaver-daemon.js'
export { createCommand as createSockets } from './commands/sockets.js'
export { createCommand as createTest } from './commands/test.js'
export { createCommand as createTheme } from './commands/theme.js'
export { createCommand as createTime } from './commands/time.js'
export { createCommand as createTrue } from './commands/true.js'
export { createCommand as createTty } from './commands/tty.js'
export { createCommand as createUmount } from './commands/umount.js'
export { createCommand as createUnzip } from './commands/unzip.js'
export { createCommand as createUser } from './commands/user.js'
export { createCommand as createVideo } from './commands/video.js'
export { createCommand as createView } from './commands/view.js'
export { createCommand as createVim } from './commands/vim.js'
export { createCommand as createWeb } from './commands/web.js'
export { createCommand as createZip } from './commands/zip.js'
