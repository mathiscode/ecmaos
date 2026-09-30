# chsh

`man @ecmaos/kernel/commands/chsh`

## Synopsis

```
chsh -s SHELL [USER]
chsh -l
```

## Description

Changes a login shell. A user may change their own; root may change anyone's. SHELL must be listed in `/etc/shells`, which names `/bin/ecmash` and `ecmaos` (the shell built into the kernel, which has no file). The value is stored in `/etc/passwd` and becomes `$SHELL` at the next login.

## Options

- `-s, --shell SHELL` -- the new login shell
- `-l, --list-shells` -- print the shells in `/etc/shells`
