# stty

`man @ecmaos/kernel/commands/stty`

## Synopsis

```
stty [-a | size | SETTING...]
```

## Description

Shows or changes the terminal's line settings. These are the real termios flags of the line discipline, so `stty -echo` stops the terminal echoing what is typed and `stty -isig` stops `^C` raising a signal. `stty size` prints the rows and columns; `stty -a` prints every setting.

## Options

- `echo, icanon, isig, echoe, echok, iexten`: local flags; a leading `-` turns one off
- `icrnl, ixon, inlcr, igncr, istrip`: input flags
- `opost, onlcr`: output flags
- `raw`: `-icanon -echo -isig -icrnl -opost`
- `cooked, -raw`: the opposite of `raw`
- `sane`: reasonable settings

## Notes

A program's terminal changes are undone when it ends, as for every program here, so at the prompt `stty -echo` is back to normal the moment it exits. It is for the command that runs beneath it (a script, `stty -echo; read -s`) and for looking.

## Exit status

0, or 1 when there is no terminal or a setting is not known.

## See also

`@ecmaos/kernel/commands/tput`, `@ecmaos/kernel/commands/tty`
