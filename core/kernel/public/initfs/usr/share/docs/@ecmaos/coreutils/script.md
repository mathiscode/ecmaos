# script

`man @ecmaos/coreutils/script`

## Synopsis

```
script [-a] [-c COMMAND] [-e] [-q] [-T FILE | -t[FILE]] [-m classic|advanced] [-I FILE] [-O FILE] [-B FILE] [--cast FILE] [FILE]
```

## Description

Record a terminal session: a shell (or `-c COMMAND`) runs on a pseudo-terminal of its own, and everything it writes is shown and kept in `FILE` (`typescript` by default), between a `Script started on ...` line that names the command, the terminal and its size, and a `Script done on ...` line with the exit status. The session ends when the shell exits (`exit` or `^D`). The terminal's settings and size are the pty's, and a resize of the window reaches the program inside.

`-a` appends instead of starting the file again, `-q` says nothing of its own, and `-e` ends with the command's status (128 plus the signal's number for a signal) instead of 0. `-I` and `-B` also keep the keys typed (`-B` in the same file as the output), `-O` names the output file.

`-T FILE` (or `-t`, to standard error or `-tFILE`) writes the timing `scriptreplay` needs to play the session back at its own speed: a delay and a byte count for each write, or in the advanced format (`-m advanced`, which logging the input as well implies) a stream letter before them.

`--cast FILE` records an asciicast v2 file, asciinema's format, instead of (or as well as) the typescript: a JSON header with the size, the time and the command, then one `[seconds, "o", text]` line per write (and `"i"` lines for the keys with `-I` or `-B`). `scriptreplay` plays it, as do asciinema and its web player.

## Examples

```
script
script -T session.timing session.log
script -q -c 'make' build.log
script --cast demo.cast
```

## See also

`scriptreplay`
