# source, .

`man @ecmaos/coreutils/source`

## Synopsis

```
source FILE [ARG ...]
. FILE [ARG ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Reads FILE and runs its commands in the current shell, so its variables, functions and aliases stay. ARGs become the positional parameters while it runs. `return` ends it early, and `BASH_SOURCE` names the file. The `EXIT` trap does not run when it ends. `.` is another name for `source`.

## Examples

```
source ~/.bashrc
```

## Exit status

The status of the last command, or 1 when FILE cannot be read.

## See also

`eval`, `return`, `@ecmaos/coreutils/skel`
