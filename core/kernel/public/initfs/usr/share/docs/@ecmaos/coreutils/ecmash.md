# ecmash

`man @ecmaos/coreutils/ecmash`

## Synopsis

```
ecmash [-l] [-c COMMAND [NAME [ARG...]]] [FILE [ARG...]]
```

## Description

The ecmaOS shell as a real program. It runs in its own worker like any other command, runs the same shell language as the shell built into the kernel (one shared parser, expander, interpreter and set of builtins), and reaches the system only through syscalls: `spawn`, `waitpid` and `killpg` for processes, `pipe` for pipelines, `open` for redirections, and the terminal ioctls for its line editor.

With no command and no file it reads commands from standard input. When that is a terminal it is interactive: a prompt (`$PS1`), line editing, and history in `~/.ecmash_history`. `^C` cancels the line being typed; while a pipeline runs, a stage killed by `SIGINT` stops the rest of that pipeline.

## Options

- `-c COMMAND` -- run COMMAND, then exit. The next word is `$0`, the rest are `$1...`
- `-l, --login` -- act as a login shell: read `/etc/profile`, then `~/.ecmash_profile` or `~/.profile`. Started with an `argv[0]` beginning with `-` (`-ecmash`) it does the same. An interactive shell also reads `~/.ecmashrc`

## Scripts

`/bin/sh` and `/bin/bash` are links to `ecmash`, and `/usr/bin/env` is a link to the `env` program, so a script
starting `#!/bin/sh`, `#!/bin/bash`, `#!/usr/bin/env sh` or `#!/usr/bin/env bash` runs on `ecmash`. It is a
bash-like shell, so a script written for POSIX `sh` runs unchanged; there is no stricter POSIX mode.

## Language

Simple commands, pipelines, `&&`, `||`, `;`, `&`; the redirections `<`, `>`, `>>`, `2>`, `2>&1`, here-documents and here-strings; `$var`, `${...}`, `$(...)`, `$((...))`, globbing; `if`, `while`, `for`, `case`, `{ ...; }` groups, `( ... )` subshells, indexed arrays (`a=(x y)`, `a+=(z)`, `a[i]=v`, `${a[@]}`, `${#a[@]}`), `<(cmd)` and `>(cmd)`, aliases, and functions.

A subshell is a snapshot, not a fork: variables, arrays, functions, aliases, the positional parameters and the working directory are put back afterwards, and `exit` inside ends only the subshell. It has to stand alone (optionally with a redirection); `(a) && b` and `(a) | b` are refused with a message. `<(cmd)` and `>(cmd)` are temporary files, so they do not stream.

Job control: `^Z` stops the foreground job, `jobs` lists, `fg` and `bg` resume, `disown` forgets, and `wait %1` waits for one.

`trap` takes `EXIT`, `ERR`, `DEBUG`, `RETURN`, `INT`, `HUP`, `QUIT`, `USR1`, `USR2`, `PIPE`, `ALRM`, `TERM` and `CHLD`. A trap for a signal runs between commands, not in the middle of one. `DEBUG` runs before each simple command (not inside a function, as in bash without `functrace`), and `RETURN` when a function or sourced file finishes.

Also: `(( expression ))` as a command (it is `let`), `$'...'` quoting, `${x@U}`, `@L`, `@u`, `@Q` and `@E`, `case` with `;&` and `;;&`, `declare -n` and `local -n` namerefs (`unset -n`), `[[ -v name ]]`, `$_`, `FUNCNAME`, `BASH_REMATCH`, `printf -v` and `%q`, and `mapfile`/`readarray`. Pathname expansion understands `[[:class:]]` and `[!x]`, looks through any number of directories (`d/*/x`), and follows `shopt`.

Builtins: `:`, `true`, `false`, `cd`, `pwd`, `echo`, `env`, `exit`, `export`, `unset`, `local`, `set --`, `shift`, `read`, `source`, `.`, `eval`, `exec`, `return`, `break`, `continue`, `type`, `command`, `test`, `[`, `wait`, `jobs`, `fg`, `bg`, `disown`, `alias`, `unalias`, `trap`, `declare`, `typeset`, `readonly`, `getopts`, `umask`, `let`, `mapfile`, `readarray`, `shopt`, `printf`.

`shopt [-pqsu] [NAME...]` changes the options that matter here: `nullglob` (a pattern with no match expands to nothing), `failglob` (it is an error), `dotglob` (wildcards match a leading dot), `nocaseglob` and `nocasematch` (ignore case in pathnames, and in `case` and `[[`), `extglob` (`@(a|b)`, `?(..)`, `*(..)`, `+(..)`, `!(..)`) and `globstar` (`**` matches any number of directories). `checkwinsize`, `cmdhist`, `histappend`, `huponexit` and `progcomp` are accepted and remembered, since they only concern an interactive session. Any other name is an error rather than silently ignored.

`umask [-p] [-S] [MODE]` shows or sets the file mode creation mask, octal (`022`) or symbolic (`u=rwx,g=rx,o=rx`, what stays allowed). It applies to the files and directories the shell and everything it starts create, including `>` redirections, and a program inherits it from the shell that ran it. `/etc/profile` sets 022 for a login shell, and pid 1 starts with 022. Programs create files with at most their own 0644 (and directories 0777), so a mask can tighten what they create and cannot loosen it. It needs a newer `@zenfs/core` than the published 2.7.6; without one `umask` says so and fails instead of pretending.

## Differences from the shell built into the kernel

Associative arrays (`declare -A`, `m[key]=v`, `m=([k]=v)`, `${!m[@]}`) work, though a key listing is in insertion order, not bash's hash order. A compound command (`while`, `{ }`, `( )`, ...) or a function can be a pipeline stage; it runs in the shell process, as a subshell, after the pipeline's programs are started. A compound command in the background (`(cmd) &`, `{ ...; } &`, `while ...; done &`) runs in a fresh `ecmash` that is given a copy of the shell's variables, arrays, functions, aliases, options and positional parameters, so it behaves as a forked subshell would (traps are reset, as in bash); a compound stage inside a background pipeline is refused. `read -t` times out. `declare -i` converts assignments to arithmetic, and `read -n` and `-d` take their input from a file or pipe. `set` takes `-e`, `-u`, `-x`, `-f`, `-C`, `-v` and `-o pipefail`; any other option is refused rather than ignored. `exec COMMAND` runs the command and exits with its status, since a worker cannot replace itself.

Output redirected to a file is written to a scratch file and copied over when the command finishes. The root filesystem loses data when a file is written in several chunks through a plain descriptor, and a whole-file write is the safe way.

## See also

`chsh`, `/etc/shells`
