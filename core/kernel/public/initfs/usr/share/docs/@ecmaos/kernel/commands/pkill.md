# pkill

`man @ecmaos/kernel/commands/pkill`

## Synopsis

```
pkill [-SIGNAL] [OPTION]... PATTERN
```

## Description

Sends a signal (SIGTERM by default) to the processes whose name matches the regular expression PATTERN. The selection options are `pgrep`'s. A signal is a number or a name in capitals: `pkill -9 sleep`, `pkill -HUP -f 'my script'`.

## Options

- `-SIGNAL, --signal SIGNAL`: the signal to send
- `-e, --echo`: print each process that is signalled
- `-c, --count`: print only how many were signalled
- `-f, -x, -i, -v, -u, -P, -n, -o`: as for `pgrep`

## Exit status

0 when something was signalled, 1 when nothing was (or a signal was refused), 2 for a bad option.

## See also

`@ecmaos/kernel/commands/pgrep`, `@ecmaos/kernel/commands/kill`, `@ecmaos/kernel/commands/killall`
