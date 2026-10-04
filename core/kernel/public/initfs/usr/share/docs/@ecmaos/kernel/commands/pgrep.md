# pgrep

`man @ecmaos/kernel/commands/pgrep`

## Synopsis

```
pgrep [OPTION]... PATTERN
```

## Description

Lists the process IDs of the processes whose name matches the regular expression PATTERN. It reads `/proc`, and never lists itself or the shell that ran it.

## Options

- `-f, --full`: match against the whole command line, not just the name
- `-x, --exact`: the whole name must match
- `-i, --ignore-case`: ignore case
- `-v, --inverse`: select the processes that do not match
- `-u, --euid USER`: only processes of USER
- `-P, --parent PPID`: only children of PPID
- `-n, --newest, -o, --oldest`: only the newest or the oldest match
- `-l, --list-name`: also print each name
- `-a, --list-full`: also print each command line
- `-c, --count`: print only how many matched
- `-d, --delimiter STR`: separate the IDs with STR

## Exit status

0 when something matched, 1 when nothing did, 2 for a bad option.

## See also

`@ecmaos/kernel/commands/pkill`, `@ecmaos/kernel/commands/ps`, `@ecmaos/kernel/commands/killall`
