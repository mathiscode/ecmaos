# logout

`man @ecmaos/coreutils/logout`

## Synopsis

```
logout [N]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Ends a login shell with status N, or the status of the last command. The shell built into the kernel is always a login shell; `/bin/ecmash` is one when started with `-l` or as `-ecmash`. Anywhere else it reports `logout: not login shell: use 'exit'` and exits 1.

## Exit status

N, or 1 when not a login shell.

## See also

`exit`, `@ecmaos/coreutils/login`
