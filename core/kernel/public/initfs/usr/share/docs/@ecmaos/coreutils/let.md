# let

`man @ecmaos/coreutils/let`

## Synopsis

```
let EXPRESSION [EXPRESSION ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Evaluates arithmetic expressions, with the C operators, assignment (`x = 3`, `x += 2`), `++` and `--`, the comma and the ternary `?:`; variables need no `$`. `(( expression ))` is the same as `let 'expression'`.

## Examples

```
let n=n+1
(( n *= 2 ))
```

## Exit status

0 when the last expression is not zero, 1 when it is.

## See also

`declare`, `@ecmaos/coreutils/expr`
