# skel

`man @ecmaos/coreutils/skel`

## Synopsis

```
/etc/skel
```

## Description

The skeleton of a new home directory. `useradd -m` (and `user add -m`) copies everything in `/etc/skel` into the home directory it creates, owned by the new user and keeping the modes the files have there. A home that already exists is left as it is, and so is every existing account's.

Boot writes any default that is missing and never overwrites one, so an edit to `/etc/skel` stands. The defaults, as on Debian:

- `.profile` - read by login shells after `/etc/profile`; puts `~/bin` and `~/.local/bin` on `$PATH` when they exist.
- `.bashrc` - read by every interactive shell; history settings (`HISTCONTROL`, `HISTSIZE`, `HISTFILESIZE`), `ls`, `grep`, `egrep` and `fgrep` with `--color=auto`, and the `ll`, `la` and `l` aliases.
- `.bash_logout` - run when a login shell exits.

Add files or directories to `/etc/skel` to give every future user the same starting point.

## See also

`@ecmaos/kernel/commands/useradd`, `@ecmaos/coreutils/ecmash`
