# getopts

`man @ecmaos/coreutils/getopts`

## Synopsis

```
getopts OPTSTRING NAME [ARG ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Parses options the way scripts conventionally do. Each call takes the next option from ARGs (the positional parameters by default) into NAME, and its argument, if any, into `$OPTARG`; `$OPTIND` is the index of the next one. A letter followed by `:` in OPTSTRING takes an argument. A leading `:` makes errors silent: NAME becomes `?` (or `:` for a missing argument). It fails when the options run out, which ends the usual `while` loop.

## Examples

```
while getopts ':ab:' opt; do
  case $opt in
    a) echo flag a;;
    b) echo "b=$OPTARG";;
  esac
done
shift $((OPTIND - 1))
```

## Exit status

0 while options remain, 1 when done.

## See also

`shift`
