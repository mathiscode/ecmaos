# dirs

`man @ecmaos/coreutils/dirs`

## Synopsis

```
dirs [-clpv] [+N] [-N]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Prints the directory stack, the working directory first, with the home directory shown as `~`.

## Options

- `-c` -- clear the stack
- `-l` -- print full paths, not `~`
- `-p` -- print one entry per line
- `-v` -- one entry per line, each with its index
- `+N` -- print only the Nth entry from the left, counting from zero
- `-N` -- print only the Nth entry from the right

## Exit status

0, or 1 when an index is out of range.

## See also

`pushd`, `popd`
