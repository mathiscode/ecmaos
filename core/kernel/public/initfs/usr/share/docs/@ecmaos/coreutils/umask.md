# umask

`man @ecmaos/coreutils/umask`

## Synopsis

```
umask [-p] [-S] [MODE]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Shows or sets the file mode creation mask: the permission bits a new file or directory is created without. MODE is octal (`022`) or symbolic (`u=rwx,g=rx,o=rx`, the permissions that stay allowed). The mask applies to files, directories and `>` redirections, and programs the shell starts inherit it. A fresh login gets `022` from `/etc/profile`. With a `@zenfs/core` that has no creation mask, `umask` says it is unsupported rather than pretend.

## Options

- `-S` - print the mask symbolically
- `-p` - print it as a command that sets it

## Examples

```
umask 077
```

## Exit status

0, or 1 when unsupported or MODE is invalid.

## See also

`chmod`, `touch`
