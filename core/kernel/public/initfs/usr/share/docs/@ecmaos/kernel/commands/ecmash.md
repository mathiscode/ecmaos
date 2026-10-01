# ecmash

`man @ecmaos/kernel/commands/ecmash`

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

## Language

Simple commands, pipelines, `&&`, `||`, `;`, `&`; the redirections `<`, `>`, `>>`, `2>`, `2>&1`, here-documents and here-strings; `$var`, `${...}`, `$(...)`, `$((...))`, globbing; `if`, `while`, `for`, `case`, `{ ...; }` groups, `( ... )` subshells, indexed arrays (`a=(x y)`, `a+=(z)`, `a[i]=v`, `${a[@]}`, `${#a[@]}`), `<(cmd)` and `>(cmd)`, aliases, and functions.

A subshell is a snapshot, not a fork: variables, arrays, functions, aliases, the positional parameters and the working directory are put back afterwards, and `exit` inside ends only the subshell. It has to stand alone (optionally with a redirection); `(a) && b` and `(a) | b` are refused with a message. `<(cmd)` and `>(cmd)` are temporary files, so they do not stream.

Job control: `^Z` stops the foreground job, `jobs` lists, `fg` and `bg` resume, `disown` forgets, and `wait %1` waits for one.

`trap` takes `EXIT`, `ERR`, `INT`, `HUP`, `QUIT`, `USR1`, `USR2`, `PIPE`, `ALRM`, `TERM` and `CHLD`; `DEBUG` and `RETURN` are refused. A trap for a signal runs between commands, not in the middle of one.

Builtins: `:`, `true`, `false`, `cd`, `pwd`, `echo`, `env`, `exit`, `export`, `unset`, `local`, `set --`, `shift`, `read`, `source`, `.`, `eval`, `exec`, `return`, `break`, `continue`, `type`, `command`, `test`, `[`, `wait`, `jobs`, `fg`, `bg`, `disown`, `alias`, `unalias`, `trap`, `declare`, `typeset`, `readonly`, `getopts`.

## Differences from the shell built into the kernel

Associative arrays (`declare -A`, `m[key]=v`, `m=([k]=v)`, `${!m[@]}`) work, though a key listing is in insertion order, not bash's hash order. A compound command (`while`, `{ }`, `( )`, ...) or a function can be a pipeline stage; it runs in the shell process, as a subshell, after the pipeline's programs are started. A background subshell (`(cmd) &`) is refused. Not implemented: arithmetic `(( ))` as a command, a subshell after `&&` or `||`, `declare -A`, and `read -t` (refused: it cannot time out a read). `declare -i` converts assignments to arithmetic, and `read -n` and `-d` take their input from a file or pipe. `set` takes `-e`, `-u`, `-x`, `-f`, `-C`, `-v` and `-o pipefail`; any other option is refused rather than ignored. `exec COMMAND` runs the command and exits with its status, since a worker cannot replace itself.

Output redirected to a file is written to a scratch file and copied over when the command finishes. The root filesystem loses data when a file is written in several chunks through a plain descriptor, and a whole-file write is the safe way.

## See also

`chsh`, `/etc/shells`
