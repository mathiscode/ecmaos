# vmstat

`man @ecmaos/coreutils/vmstat`

## Synopsis

```
vmstat [-n] [DELAY [COUNT]]
```

## Description

Reports processes, memory and CPU, from toybox 0.8.12, read from `/proc/stat`, `/proc/meminfo` and `/proc/vmstat`. With a `DELAY` in seconds it repeats (`COUNT` times, or until stopped); `-n` prints the header once.

The browser has no swap and no paging counters, so `swpd`, `si`, `so`, `bi` and `bo` are 0, and it does not tell the kernel how long a WebAssembly program has run, so the CPU columns read 100 idle. The memory columns come from what the browser reports, which is a little (Chrome gives the size of the JavaScript heap and the machine's memory, other browsers less).

## Examples

```
vmstat
vmstat 2 5
```

## See also

`@ecmaos/coreutils/free`, `@ecmaos/coreutils/uptime`, `@ecmaos/kernel/commands/top`

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/vmstat/`.
