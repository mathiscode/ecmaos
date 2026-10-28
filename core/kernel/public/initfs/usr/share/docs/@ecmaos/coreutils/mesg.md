# mesg

`man @ecmaos/coreutils/mesg`

## Synopsis

```
mesg [y | n]
```

## Description

Allow or refuse messages from `write` and `wall` on the terminal this runs in. A terminal's device (`/dev/xterm0`, or `/dev/pts/N`) starts world-writable, which is "yes"; `mesg n` takes the group and other write bits away and `mesg y` puts them back. With no argument it prints `is y` or `is n`.

`write` and `wall` look at those bits: `write` to a terminal that refused fails with `messages disabled`, `wall` skips it. root writes anyway, as on Linux.

Exit status: 0 for yes, 1 for no, 2 for an error (standard input is not a terminal, a bad argument).

## See also

`write`, `wall`, `who`, `tty`
