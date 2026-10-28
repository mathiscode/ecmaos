# cmatrix

`man @ecmaos/coreutils-copyleft/cmatrix`

## Synopsis

```
cmatrix [-abBcLnorsmV] [-u DELAY] [-C COLOR]
```

## Description

cmatrix 2.0: the falling green characters of The Matrix, until `q` (or `^C`). `-b` and `-B` make some or all of the characters bold (`-n` none), `-C` picks the colour (green, red, blue, white, yellow, cyan, magenta or black), `-r` colours it in a rainbow, `-m` rains lambdas, `-u` sets the delay (0 to 10, default 4), `-a` scrolls asynchronously, `-o` scrolls the old way, `-c` uses Japanese characters, `-s` is a screensaver that ends at the first key and `-L` locks the terminal until it is stopped from another one. While it runs, keys change it: `0` to `9` the speed, `!` `@` `#` `$` `%` `^` `&` the colour, `r` and `m` the rainbow and lambdas, `b` `B` `n` the boldness, `a` asynchronous scrolling, `p` pause and `q` quit.

The options for the Linux console and its fonts (`-f`, `-l`, `-x`) have no console font to load here.

## Examples

```
cmatrix -b
cmatrix -r -u 2
cmatrix -s -C cyan
```

## License

GPL-3.0-or-later (statically linked with ncurses, X11 license). The license text and the offer of source are in `/usr/share/licenses/@ecmaos/coreutils-copyleft/cmatrix/`.

## See also

`sl`, `htop`
