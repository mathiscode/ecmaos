# killall

`man @ecmaos/kernel/commands/killall`

## Synopsis

```
killall [-s SIGNAL | -SIGNAL] NAME...
```

## Description

Sends a signal to every real process whose command name matches `NAME` (`SIGTERM` if none is given). Process names are read from `/proc`, the same place `ps` reads them, so `killall` sees exactly the processes `ps` would list.

## Options

- `-s, --signal SIGNAL` - signal to send, by name (`TERM`) or number (`15`)
- `-SIGNAL` - shorthand, e.g. `-9` or `-KILL`
- `--help` - display usage and exit

## See also

`@ecmaos/kernel/commands/kill`, `@ecmaos/kernel/commands/ps`
