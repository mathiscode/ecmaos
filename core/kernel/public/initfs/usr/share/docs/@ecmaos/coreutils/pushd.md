# pushd

`man @ecmaos/coreutils/pushd`

## Synopsis

```
pushd [-n] [+N | -N | DIR]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Adds a directory to the directory stack and changes to it, or rotates the stack. The stack is kept per shell; `DIRSTACK` shows it with the working directory first, and a subshell gets its own copy. After a successful change the stack is printed as `dirs` prints it.

Without arguments it exchanges the top two entries, which is how `pushd` flips between two directories.

## Options

- `-n` -- do not change directory; only add DIR to the stack, just below the working directory
- `+N` -- rotate the stack so the Nth entry from the left (counting from zero) is the working directory
- `-N` -- the same, counting from the right
- `DIR` -- make DIR the working directory and push the old one

## Examples

```
cd /tmp
pushd /usr     # /usr /tmp
pushd          # /tmp /usr
pushd +1       # /usr /tmp
```

## Exit status

0 on success; 1 when DIR cannot be entered, the stack has no other directory (`pushd: no other directory`), or an index is out of range.

## See also

`popd`, `dirs`, `cd`, `@ecmaos/coreutils/ecmash`
