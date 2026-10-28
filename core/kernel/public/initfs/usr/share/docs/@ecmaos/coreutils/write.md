# write

`man @ecmaos/coreutils/write`

## Synopsis

```
write USER [TTY]
```

## Description

Send standard input to the terminal USER is logged in on, until end of input. When the user has more than one terminal, name it with `TTY` (`tty1` or `1`); otherwise the first is used and a note says so. A terminal that ran `mesg n` refuses the message (`messages disabled`), unless root writes.

## Options

```
  --help  display this help and exit
```

## See also

`wall`, `mesg`, `who`, `last`
