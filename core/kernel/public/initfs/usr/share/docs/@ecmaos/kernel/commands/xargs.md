# xargs

`man @ecmaos/kernel/commands/xargs`

## Synopsis

```
xargs [OPTION]... [COMMAND [INITIAL-ARGS]...]
```

## Description

Builds command lines from standard input and runs them, `echo` by default: `find . -name '*.tmp' | xargs rm`. Input is split at blanks and newlines, with single quotes, double quotes and backslashes grouping and escaping; `-0` and `-d` split at one character instead. The arguments go to as few runs of the command as the size limit allows, or `-n` at a time, or one input line at a time with `-I`. The command is run with no standard input of its own (it reads end of file).

## Options

- `-0, --null`: items end with a NUL
- `-d, --delimiter=CHAR`: items end with CHAR
- `-n, --max-args=N`: at most N arguments per command line
- `-L, --max-lines=N`: at most N input lines per command line
- `-I REPLACE, -i`: run once per input line, replacing REPLACE (`{}` for `-i`) in the arguments with the line
- `-r, --no-run-if-empty`: do not run the command when there is no input
- `-s, --max-chars=N`: at most N characters per command line (default 131072)
- `-P, --max-procs=N`: run up to N commands at a time
- `-t, --verbose`: print each command line on standard error first
- `-x, --exit`: accepted for compatibility

## Exit status

0 when every command succeeded, 123 when one exited 1-125, 124 when one exited 255 (which also stops xargs), 125 when one was killed by a signal, 126 when the command cannot run, 127 when it is not found.

## See also

`find`, `@ecmaos/kernel/commands/timeout`
