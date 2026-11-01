# dc

`man @ecmaos/coreutils/dc`

## Synopsis

```
dc [-e expr] [-f file] [file ...]
```

## Description

The reverse-polish calculator, in arbitrary precision. Numbers and strings go on a stack; `+ - * / % ~ ^ v |` do arithmetic at the current scale (`k` sets it, `K` reads it), `i` and `o` set the input and output radix, `p n P f` print, `c d r R z Z X a` handle the stack, `s l S L` use registers, `: ;` arrays, `x` runs a string as a macro, `> < = !> !< !=` run a register when the comparison holds, `q` and `Q` quit. `_` makes a number negative, `#` starts a comment. Reads standard input when no `-e`, `-f` or file is given. A long number is folded at 69 columns with a backslash, as dc does. The `?` command reads a line from standard input.

## Examples

```
dc -e '2 100 ^ p'
dc -e '10k 2 v p'
echo "16 o 255 p" | dc
```

## See also

`@ecmaos/coreutils/expr`, `@ecmaos/coreutils/factor`

## License

MIT OR Apache-2.0.
