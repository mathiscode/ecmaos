# yes

`man @ecmaos/kernel/commands/yes`

## Synopsis

```
yes [STRING]...
```

## Description

Prints a line made of the STRINGs (or `y`) over and over, until the reader of the pipe is gone: `yes | head -n 3`, or `yes | rm -i *`.

## Exit status

141 when the reader closed the pipe (what SIGPIPE gives on Linux).

## See also

`@ecmaos/kernel/commands/seq`
