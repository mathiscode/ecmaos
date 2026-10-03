# su

`man @ecmaos/kernel/commands/su`

## Synopsis

```
su [-] [-l] [-c COMMAND] [-s SHELL] [-m] [USER [ARG]...]
```

## Description

Runs a shell as another user, root by default. The shell is a child process that runs as that user: `exit` (or `^D`) ends it and puts you back in the shell that ran `su`, as yourself. Nothing about the shell you came from changes.

Root is never asked for a password. Anyone else is asked for the password of the user they want to become, with echo off; a wrong one prints `su: Authentication failure` and exits 1. The prompt is drawn on the terminal even when the command's output is redirected.

The target's shell is the one in their `/etc/passwd` entry when that is a program, such as `/bin/ecmash`. When it is the kernel's built-in `ecmaos` shell, which has no file to run, `/bin/ecmash` is used instead.

## Options

- `-`, `-l`, `--login`: a login shell: an empty environment apart from `TERM` and `PATH`, started in the target's home directory.
- `-c COMMAND`, `--command=COMMAND`: run COMMAND in the shell, then exit with its status.
- `-s SHELL`, `--shell=SHELL`: run SHELL instead of the target's shell.
- `-m`, `-p`, `--preserve-environment`: keep `USER` and `LOGNAME` as they were. `HOME` and `SHELL` are always set.
- `-h`, `--help`: print the usage.

Without `-`, the environment is kept and `HOME`, `SHELL`, `USER` and `LOGNAME` become the target's, and the shell starts in the current directory.

## How it works

`su` has the setuid bit (mode 4755, owned by root). The kernel starts it with root's effective user id while its real user id stays the caller's, which is how it tells root from everyone else; it then starts the shell with the target's ids through the root-only `credentials` option of `proc_spawn`. Only a program the kernel runs with the setuid bit can do this, so an ordinary program cannot.

It needs programs to run as the user who started them, which needs a newer `@zenfs/core` than the published 2.7.6 (see the README's Known gaps). Without that, `su` refuses with a message instead of handing out root.

## Exit status

The status of the shell or command. 1 for an unknown user or a failed login, 2 for a bad option, 126 when the shell cannot be started.

## See also

`@ecmaos/kernel/commands/sudo`, `@ecmaos/kernel/commands/passwd`, `@ecmaos/kernel/commands/chsh`
