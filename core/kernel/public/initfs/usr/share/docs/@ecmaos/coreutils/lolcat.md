# lolcat

`man @ecmaos/coreutils/lolcat`

## Synopsis

```
lolcat [-h FREQ] [-v FREQ] [-f] [-r] [-s SEED] [-o OFFSET] [-g RGB:RGB] [-b|-x] [-i] [FILE ...]
```

## Description

lolcat 1.5 (jaseg's C lolcat): `cat` in a rainbow. It writes the files, or standard input, with each character coloured along a rainbow that runs across and down. `-h` and `-v` set how fast it changes horizontally and vertically, `-r` and `-s` pick random colours, `-o` starts somewhere else in the rainbow and `-g ff4444:00ffff` uses a gradient between two colours instead. It uses 256 colours; `-b` uses 24-bit colour (which this terminal has) and `-x` 16. Colour is only written to a terminal, unless `-f` forces it; `-i` colours the background instead.

## Examples

```
ls -l | lolcat
figlet ecmaOS | lolcat -b
fortune | cowsay | lolcat
```

## License

WTFPL. The license text is in `/usr/share/licenses/@ecmaos/coreutils/lolcat/`.

## See also

`cat`, `figlet`, `cowsay`
