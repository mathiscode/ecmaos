# popd

`man @ecmaos/coreutils/popd`

## Synopsis

```
popd [-n] [+N | -N]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Removes an entry from the directory stack. With no argument it removes the top entry and changes to the new top; with `+N` or `-N` it removes that entry and leaves the working directory alone, unless the entry is the working directory itself. The stack is printed afterwards.

## Options

- `-n` -- do not change directory; with no argument, remove the entry just below the working directory
- `+N` -- remove the Nth entry from the left, counting from zero
- `-N` -- remove the Nth entry from the right

## Exit status

0 on success; 1 when the stack is empty (`popd: directory stack empty`) or an index is out of range.

## See also

`pushd`, `dirs`, `cd`
