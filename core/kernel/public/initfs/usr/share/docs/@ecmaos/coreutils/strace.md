# strace

`man @ecmaos/coreutils/strace`

## Synopsis

```
strace [OPTION]... COMMAND [ARG]...
strace [OPTION]... -p PID
```

## Description

Runs COMMAND and prints the system calls it makes, one per line, to standard error (or the file `-o` names). With `-p` it attaches to a process that is already running instead. The command's own output goes where it always did. The status is the command's.

```
open("/bin/echo", O_RDONLY, 0644) = 3
read(3, "// ../utils/src/lib/echo-text.ts"..., 65536) = 3708
write(1, "hi\n", 3) = 3
exit(0) = ?
+++ exited with 0 +++
```

A failed call shows its error: `stat("/no/such/file") = -1 ENOENT (No such file or directory)`.

## Options

- `-f`: also trace the programs the command starts. Lines then begin with `[pid N]`
- `-o FILE`: write the trace to FILE
- `-s N`: show at most N bytes of a string or buffer (default 32)
- `-e trace=SET`: only these calls, by name or by set: `file`, `desc`, `process`, `signal`, `network`. A leading `!` excludes them. May be repeated
- `-c`: count the calls and print a table at the end instead of the calls
- `-t`, `-tt`, `-r`: a time on each line: seconds, seconds with microseconds, or the time since the previous call
- `-y`: show the path an fd was opened from beside its number
- `-p PID`: attach to a running process. Root may attach to any process; anyone else only to their own user's. `^C` detaches

## What it is not

`strace` here records the stream of calls the kernel serves. It is not `ptrace`: the program is never stopped, stepped or have its memory read or changed.

- Arguments are what the kernel received. A program running as a JavaScript or WebAssembly module makes its calls through a layer that has already turned pointers into strings and bytes, so no raw addresses appear.
- A call such as `wait` or `poll` that blocks is shown when it returns, not when it starts.
- The first calls of a program are those of the interpreter that starts it (`/bin/node`, `/bin/wali`), reading the program's file.
- Times are taken on the main thread and include waiting behind other programs' calls.
- A program tracing itself, or one already traced, cannot be traced again.
- WebAssembly that falls back to the main thread (see the known gaps) makes no calls through this path and shows nothing.

## Exit status

The command's, 1 when `strace` itself failed (an unknown option, a command that is not there, a process that cannot be attached).

## See also

`@ecmaos/coreutils/timeout`, `@ecmaos/kernel/commands/kill`
