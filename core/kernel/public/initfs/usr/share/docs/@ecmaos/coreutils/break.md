# break

`man @ecmaos/coreutils/break`

## Synopsis

```
break [N]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Leaves the enclosing `for`, `while`, `until` or `select` loop. With N it leaves that many enclosing loops. Outside a loop it prints a diagnostic and does nothing.

## Examples

```
for i in 1 2 3; do
  [ $i = 2 ] && break
  echo $i
done
```

## Exit status

0.

## See also

`continue`
