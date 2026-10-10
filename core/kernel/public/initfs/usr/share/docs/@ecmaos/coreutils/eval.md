# eval

`man @ecmaos/coreutils/eval`

## Synopsis

```
eval [ARG ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Joins the arguments with spaces and runs the result as shell commands in the current shell, after the usual expansions, so it can build commands from data. The status is that of what it ran.

## Examples

```
cmd='echo $HOME'
eval "$cmd"
```

## Exit status

The status of the command run.

## See also

`source`, `command`
