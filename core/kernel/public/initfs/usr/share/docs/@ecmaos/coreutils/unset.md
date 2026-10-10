# unset

`man @ecmaos/coreutils/unset`

## Synopsis

```
unset [-f | -v | -n] NAME[[INDEX]] ...
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Removes variables, functions or array elements (`unset a[2]`). A readonly variable cannot be unset.

## Options

- `-v` -- variables only
- `-f` -- functions only
- `-n` -- remove the reference NAME itself, not the variable it names

## Exit status

0, or 1 for a readonly name.

## See also

`declare`, `readonly`
