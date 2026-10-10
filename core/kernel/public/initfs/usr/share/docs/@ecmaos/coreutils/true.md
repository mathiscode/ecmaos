# true

`man @ecmaos/coreutils/true`

## Synopsis

```
true
```

## Description

Does nothing, successfully. A program as well as a shell builtin, for `env true`, `xargs true` and `find -exec true`.

The shell builtin `:` (a colon) is the same command, with no program behind it: it does nothing, successfully, after its arguments are expanded. `while :; do ...; done` loops forever.

## Exit status

Always 0.

## See also

`@ecmaos/coreutils/false`
