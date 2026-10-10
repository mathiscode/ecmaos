# exec

`man @ecmaos/coreutils/exec`

## Synopsis

```
exec [REDIRECTION ...]
exec COMMAND [ARG ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. With only redirections, applies them to the shell itself for the rest of its life: `exec > log` sends all later output to `log`, and `exec < file` makes `file` its input. In `/bin/ecmash`, `exec COMMAND` runs the command and then ends the shell with its status. The shell built into the kernel does not replace itself with a command: it says so and fails.

## Examples

```
exec > /tmp/log 2>&1
echo goes to the log
```

## Exit status

0, or the command's status.

## See also

`eval`, `exit`
