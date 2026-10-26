# sudo

`man @ecmaos/coreutils/sudo`

## Synopsis

```
sudo [-u USER] [-n] [-S] [-k | -K] [--] COMMAND [ARG]...
sudo [-u USER] [-n] [-S] -i | -s [COMMAND [ARG]...]
sudo -v | -l | -k
sudo [-n] [-S] -e FILE...
```

## Description

Runs a command as another user, root by default, if `/etc/sudoers` allows it. The password it asks for is your own, not the target's, and it is remembered for `timestamp_timeout` minutes (5 unless the file says otherwise) so a run of commands asks once. Root is never asked.

The command is found on your `PATH`, as a shell would, and runs with the target's ids. Shell builtins such as `cd` are not programs, so `sudo cd` reports `command not found`, as on Linux. The environment is kept, with `HOME`, `USER` and `LOGNAME` set to the target's and `SUDO_USER`, `SUDO_UID`, `SUDO_GID` and `SUDO_COMMAND` saying who asked and for what. The command's exit status is `sudo`'s.

A command that is stopped with `^Z` is resumed at once: `sudo` is not a job a shell can hold.

## Options

- `-u USER`, `--user=USER`: run as USER. The rule must allow that user.
- `-i`, `--login`: run the target's shell as a login shell, in their home directory, or run COMMAND through it.
- `-s`, `--shell`: run the target's shell, or run COMMAND through it.
- `-n`, `--non-interactive`: never ask for a password; fail if one is needed.
- `-S`, `--stdin`: read the password from standard input, not the terminal, and prompt on standard error.
- `-k`, `-K`: forget the remembered password.
- `-v`: ask for the password and remember it, running nothing.
- `-l`, `--list`: list what you may run. It does not ask for a password.
- `-e`, `--edit`: edit the files as root in your own editor, as `sudoedit` does (see `@ecmaos/coreutils/sudoedit`).

## /etc/sudoers

Mode 0440, readable by root only. It is written at first boot as:

```
Defaults timestamp_timeout=5

root    ALL=(ALL:ALL) ALL
%sudo   ALL=(ALL:ALL) ALL
```

Edit it as root. A rule is `WHO HOST=(RUNAS) COMMANDS`; see `@ecmaos/coreutils/sudoers` for the grammar that is understood. A line that does not parse is reported on standard error and skipped, so one typo does not lock everyone out.

If the file is missing, nobody may use `sudo`.

## How it works

`sudo` has the setuid bit (mode 4755, owned by root), so the kernel starts it as root while its real user id stays the caller's. That lets it read `/etc/sudoers`, check your password with a root-only system call, and start the command with the target's ids through `proc_spawn`'s root-only `credentials` option.

The remembered password is a file per user in `/run/sudo/ts`, a directory only root can enter, so a user cannot forge one. It is per user, not per terminal, and does not survive a reboot.

It needs programs to run as the user who started them, which needs a newer `@zenfs/core` than the published 2.7.6 (see the README's Known gaps). Without that, `sudo` refuses with a message instead of handing out root.

## Exit status

The command's. 1 when `sudo` itself refuses (not allowed, wrong password, unknown user, no such command), 126 when the command cannot be started.

## See also

`sudoedit`, `@ecmaos/coreutils/sudoers`, `@ecmaos/coreutils/su`, `@ecmaos/kernel/commands/passwd`
