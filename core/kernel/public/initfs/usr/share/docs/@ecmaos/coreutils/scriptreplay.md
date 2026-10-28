# scriptreplay

`man @ecmaos/coreutils/scriptreplay`

## Synopsis

```
scriptreplay [-t] TIMING [TYPESCRIPT [DIVISOR]]
scriptreplay -T TIMING [-O FILE | -I FILE | -B FILE] [-x out|in] [-d DIVISOR] [-m MAXDELAY]
scriptreplay [--cast] FILE.cast [DIVISOR]
```

## Description

Play a session `script` recorded back on the terminal, at the speed it was written. A typescript needs its timing file (`script -T`); either format, classic or advanced, is read, and with the advanced one `-x in` plays the keys typed instead of the output. An asciicast (asciinema's `.cast`, version 2 or 3, as `script --cast` writes) carries its own timing and plays by itself.

`-d` divides every pause (`-d 2` plays twice as fast; a third operand does the same), and `-m` caps a pause at that many seconds, for a recording with long idle stretches.

## Examples

```
scriptreplay -t session.timing session.log
scriptreplay session.timing session.log 4
scriptreplay -m 1 demo.cast
```

## See also

`script`
