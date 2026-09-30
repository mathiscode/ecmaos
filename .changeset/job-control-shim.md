---
"@ecmaos/coreutils": minor
"@ecmaos/kernel": minor
"@ecmaos/types": patch
---

## Job control shim, shared stdin for blocks, brace groups

Programs get `waitpid` (with `WNOHANG` and a Linux-shaped wait status that tells an exit code from a death by signal), `setpgid`/`getpgid`/`killpg`, a `spawn` taking `env` and `fds`, plus `getpid`, `getuid` and friends, `chdir` and `lseek`. `proc_kill` now checks the caller may signal the target, and a spawned child raises `SIGCHLD` on its parent. The whole shim is one file, `job-control.ts`, written to be deleted when `@zenfs/linux` gains these calls.

A finished background job is reported as `[1]+  Done  cmd` just before the next prompt, once, and then leaves `jobs`.

A real command inside a redirected block (`while read a; do cat; done < f`) now reads from the block's shared input and hands back what it did not consume, instead of getting an empty stdin. `eval` and `source` inherit the pipe they sit in, on both stdin and stdout.

Brace groups `{ list; }` now parse and run, with a redirection on the closing brace; before, `{` was looked up as a command.
