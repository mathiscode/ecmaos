# figlet

`man @ecmaos/coreutils/figlet`

## Synopsis

```
figlet [-f FONT] [-d DIR] [-c|-l|-r|-x] [-t|-w WIDTH] [-k|-S|-s|-o|-W|-m MODE] [-p|-n] [-C CONTROLFILE] [-I INFO] [MESSAGE]
```

## Description

FIGlet 2.2.5: large letters made of ordinary characters, from `MESSAGE` or, without one, from each line of standard input. `-f` picks a font (`figlet -f slant`); the fonts are in `/usr/share/figlet` (standard, banner, big, block, bubble, digital, lean, mini, mnemonic, script, shadow, slant, small, smscript, smshadow, smslant, term and ivrit), with the control files `-C` takes. `-c`, `-l` and `-r` centre, left-align and right-align; `-t` fits the terminal's width and `-w` gives one. `-k`, `-W`, `-S` and `-s` choose kerning, full width, smushing and the font's own default. `-I2` prints the font directory.

## Examples

```
figlet ecmaOS
figlet -f slant -c Hello
date +%T | figlet -f big
```

## License

BSD-3-Clause, the fonts too; zipio is MIT. The license text is in `/usr/share/licenses/@ecmaos/coreutils/figlet/`.

## See also

`cowsay`, `lolcat`
