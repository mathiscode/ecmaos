# set

`man @ecmaos/coreutils/set`

## Synopsis

```
set [-/+abefCuvx] [-/+o [OPTION]] [--] [ARG ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. With options, turns shell options on (`-`) or off (`+`). With arguments and no option, or after `--`, replaces the positional parameters. With nothing at all it prints every variable.

## Options

- `-e (errexit)` -- exit when a command fails outside a condition, `&&`/`||` operand or `!`; the `ERR` trap runs first
- `-u (nounset)` -- treat an unset variable as an error
- `-x (xtrace)` -- print each command, behind `$PS4` (default `+ `), before running it
- `-f (noglob)` -- turn pathname expansion off
- `-C (noclobber)` -- `>` refuses to overwrite an existing file; `>|` overrides
- `-v (verbose)` -- echo each line of input as it is read
- `-o pipefail` -- a pipeline's status is that of its last failing stage
- `-o` -- with no name, list every option and its state

## Examples

```
set -euo pipefail
set -- a b c; echo $#   # 3
```

## Exit status

0, or 2 for an unknown option.

## See also

`shopt`, `shift`, `trap`
