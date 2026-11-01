# look

`man @ecmaos/coreutils/look`

## Synopsis

```
look [-adf] [-t char] string [file ...]
```

## Description

Prints the lines of a sorted file that begin with `string`. Without a file it reads `/usr/share/dict/words`, which ecmaOS does not ship, so name a file. `-f` ignores case, `-d` compares only blanks and alphanumerics, `-t` ends the comparison at a character. Exit status is 1 when nothing matched.

## Examples

```
look ap /tmp/words
look -f AP /tmp/words
```

## See also

`@ecmaos/coreutils/grep`, `@ecmaos/coreutils/sort`

## License

MIT OR Apache-2.0.
