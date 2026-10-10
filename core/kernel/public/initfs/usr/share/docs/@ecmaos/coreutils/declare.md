# declare

`man @ecmaos/coreutils/declare`

## Synopsis

```
declare [-aAfFinprx] [NAME[=VALUE] ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Sets variables and their attributes. Inside a function it makes the variable local, as `local` does. With `-p` and no NAME it prints every variable as a `declare` command that would recreate it.

## Options

- `-a` -- indexed array
- `-A` -- associative array (`m[key]=v`, `${!m[@]}`)
- `-i` -- assignments are evaluated as arithmetic
- `-n` -- NAME is a reference to the variable named by its value
- `-r` -- readonly
- `-x` -- export to child processes
- `-p` -- print NAMEs with their attributes
- `-f` -- print function definitions
- `-F` -- print function names only

## Examples

```
declare -A age=([ann]=31 [bob]=27)
declare -i n=2+3   # 5
```

## Exit status

0, or 1 when a NAME is readonly or invalid.

## See also

`typeset`, `local`, `readonly`, `export`
