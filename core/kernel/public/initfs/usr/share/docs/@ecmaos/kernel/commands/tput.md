# tput

`man @ecmaos/kernel/commands/tput`

## Synopsis

```
tput [-T TYPE] CAPABILITY [ARGUMENT]...
```

## Description

Prints a terminal capability. ecmaOS terminals are xterm-compatible, so these are the ANSI sequences xterm uses; `cols` and `lines` are the terminal's real size, and `colors` is 256. `-T` is accepted and ignored.

## Options

- `cols, lines, colors`: size and colors
- `clear, home, el, ed`: clear the screen, home the cursor, clear to the end of the line or screen
- `cup ROW COL`: move the cursor (0-based)
- `cuu1, cud1, cuf1, cub1, cuu N, cud N, cuf N, cub N`: move the cursor
- `bold, dim, smul, rmul, rev, sgr0`: text attributes; `sgr0` clears them
- `setaf N, setab N`: foreground and background color, 0-255
- `civis, cnorm`: hide and show the cursor
- `smcup, rmcup`: switch to and from the alternate screen
- `bel, cr, nl, sc, rc`: bell, carriage return, newline, save and restore the cursor

## Exit status

0, or 1 for an unknown capability or a missing argument.

## See also

`@ecmaos/kernel/commands/stty`, `@ecmaos/kernel/commands/clear`
