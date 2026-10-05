# timeout

`man @ecmaos/coreutils/timeout`

## Synopsis

```
timeout [OPTION]... DURATION COMMAND [ARG]...
```

## Description

Runs COMMAND and stops it if it is still running after DURATION: a number with an optional suffix, `s` (the default), `m`, `h` or `d`, which may be fractional. 0 means no limit. When the time is up the command gets SIGTERM, or the signal given with `-s`; with `-k` it gets SIGKILL as well if it is still running after a further delay.

## Options

- `-s, --signal=SIGNAL`: the signal to send, by name or number
- `-k, --kill-after=TIME`: also send KILL TIME after the first signal
- `--preserve-status`: exit with the command's own status even when it timed out
- `--foreground`: accepted for compatibility

## Exit status

124 when the time ran out (unless `--preserve-status`), 125 when `timeout` itself failed, 126 when the command cannot run, 127 when it is not found, otherwise the command's status (128 plus the signal if it was killed).

## See also

`@ecmaos/coreutils/xargs`, `@ecmaos/kernel/commands/kill`
