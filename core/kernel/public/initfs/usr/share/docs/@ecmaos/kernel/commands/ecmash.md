# ecmash

`man @ecmaos/kernel/commands/ecmash`

## Synopsis

```
ecmash [-l] [-c COMMAND [NAME [ARG...]]] [FILE [ARG...]]
```

## Description

The ecmaOS shell as a real program. It runs in its own worker like any other command, uses the same parsers as the shell built into the kernel, and reaches the system only through syscalls: `spawn`, `waitpid` and `killpg` for processes, `pipe` for pipelines, `open` for redirections, and the terminal ioctls for its line editor.

With no command and no file it reads commands from standard input. When that is a terminal it is interactive: a prompt (`$PS1`), line editing, and history in `~/.ecmash_history`. `^C` cancels the line being typed; while a pipeline runs, a stage killed by `SIGINT` stops the rest of that pipeline.

## Options

- `-c COMMAND` -- run COMMAND, then exit. The next word is `$0`, the rest are `$1...`
- `-l, --login` -- act as a login shell: read `/etc/profile`, then `~/.ecmash_profile` or `~/.profile`. Started with an `argv[0]` beginning with `-` (`-ecmash`) it does the same. An interactive shell also reads `~/.ecmashrc`

## Language

Simple commands, pipelines, `&&`, `||`, `;`, `&`; the redirections `<`, `>`, `>>`, `2>`, `2>&1`, here-documents and here-strings; `$var`, `${...}`, `$(...)`, `$((...))`, globbing; `if`, `while`, `for`, `case`, `{ ...; }` groups and functions.

Builtins: `:`, `true`, `false`, `cd`, `pwd`, `echo`, `env`, `exit`, `export`, `unset`, `local`, `set --`, `shift`, `read`, `source`, `.`, `eval`, `exec`, `return`, `break`, `continue`, `type`, `command`, `test`, `[`, `wait`, `jobs`.

## Differences from the shell built into the kernel

Not implemented: arrays, process substitution, aliases, `trap`, `set -e` and the other `set` options (`set` says so rather than ignoring them), `fg` and `bg`. `exec COMMAND` runs the command and exits with its status, since a worker cannot replace itself.

Output redirected to a file is written to a scratch file and copied over when the command finishes. The root filesystem loses data when a file is written in several chunks through a plain descriptor, and a whole-file write is the safe way.

## See also

`chsh`, `/etc/shells`
