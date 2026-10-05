# clear

`man @ecmaos/kernel/commands/clear`

## Synopsis

```
clear
```

## Description

Clear the terminal screen and move the cursor to the top left. It writes the escape sequence `ESC[2J ESC[H` to standard output, so the output is cleared only when standard output is a terminal.

## See also

`@ecmaos/coreutils/getty`
