# free

`man @ecmaos/coreutils/free`

## Synopsis

```
free [-h|-k|-m]
```

## Description

Reports the amount of memory the browser makes available, read from `/proc/meminfo` (populated at boot from `navigator.deviceMemory` and related browser-reported figures -- there is no real physical-memory introspection available to a page, so these numbers are the browser's own best estimate, not a kernel-verified figure).

## Options

- `-h` -- human-readable output, auto-scaled to the largest sensible unit (K/M/G)
- `-k` -- show output in kibibytes (the default)
- `-m` -- show output in mebibytes
- `--help` -- display usage and exit

## Notes

`free` needs no new syscall: `/proc/meminfo` is a normal file, read the same way any other coreutil reads any other `/proc` entry.

## See also

`@ecmaos/kernel/commands/ps`, `@ecmaos/kernel/commands/df`
