# command

`man @ecmaos/coreutils/command`

## Synopsis

```
command [-v|-V] NAME [ARG ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Runs NAME with ARGs, skipping any shell function (or alias) of that name, which is how a wrapper calls the real thing: `ls() { command ls -F "$@"; }`. With `-v` it prints what would run instead (the path of a file, the name of a builtin, an alias definition); `-V` describes it in words, as `type` does.

## Options

- `-v` - print what would run
- `-V` - describe what would run

## Exit status

The status of the command, or 1 when `-v` finds nothing (127 when the command is not found).

## See also

`type`, `hash`
