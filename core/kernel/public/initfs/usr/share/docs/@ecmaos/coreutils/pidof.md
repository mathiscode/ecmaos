# pidof

`man @ecmaos/coreutils/pidof`

## Synopsis

```
pidof [-s] [-o OMITPID[,OMITPID...]] [NAME]...
```

## Description

Prints the process ids of the programs named, from toybox 0.8.12. `-s` prints one id, and `-o` leaves some out (`%PPID` is the parent of `pidof`). Exits 1 when no process matches.

## Examples

```
pidof init
kill $(pidof dropbear)
```

## See also

`@ecmaos/coreutils/ps`, `@ecmaos/kernel/commands/pgrep`

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/pidof/`.
