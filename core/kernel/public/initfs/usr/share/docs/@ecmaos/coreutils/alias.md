# alias

`man @ecmaos/coreutils/alias`

## Synopsis

```
alias [NAME[=VALUE] ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. With `NAME=VALUE` defines an alias: when NAME is the first word of a command, VALUE replaces it. With only a NAME, prints that alias; with no arguments, prints every alias as `alias NAME='VALUE'`. Aliases live in the shell that defined them; put them in `~/.bashrc` (or `~/.ecmashrc`) to have them in every interactive shell.

## Examples

```
alias ll='ls -alF'
alias
```

## Exit status

0, or 1 when a NAME has no alias.

## See also

`unalias`, `@ecmaos/coreutils/skel`, `type`
