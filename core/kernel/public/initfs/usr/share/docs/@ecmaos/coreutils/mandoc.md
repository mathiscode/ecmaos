# mandoc

`man @ecmaos/coreutils/mandoc`

## Synopsis

```
mandoc [-T output] [-O options] [-W level] [FILE]...
```

## Description

mandoc 1.14.6 formats man(7) and mdoc(7) pages, the markup of Unix manual pages, which this system's own `man` does not read. `-T` picks the output: `ascii` and `utf8` (the default, for a terminal), `html`, `markdown`, `man` (mdoc converted to man), `tree` (the parse tree) and `lint` (only report what is wrong with the page). `-O fragment` leaves out the HTML wrapper, `-O style=FILE` sets the style sheet, and `-W` chooses how much to warn about. With no file it reads standard input.

The text output marks bold and underlined words by overstriking, as `nroff` does; `less` shows that as bold and underline, and `col -b` or `sed` removes it. The page database (`apropos`, `makewhatis`) and the CGI program are not built: this is only the formatter.

## Examples

```
mandoc -T utf8 ls.1 | less
mandoc -T html -O fragment page.1 > page.html
mandoc -T lint page.1
```

## License

ISC, with a few BSD-2-Clause and BSD-3-Clause files (listed in the license text); zlib from emscripten is under the zlib license. The texts are in `/usr/share/licenses/@ecmaos/coreutils/mandoc/`.
