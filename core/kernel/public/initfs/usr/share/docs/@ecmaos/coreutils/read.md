# read

`man @ecmaos/coreutils/read`

## Synopsis

```
read [-rs] [-a ARRAY] [-d DELIM] [-n COUNT] [-t SECONDS] [-p PROMPT] [NAME ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Reads one line from standard input and splits it into fields with `$IFS`, assigning one to each NAME and the rest to the last. With no NAME the line goes unsplit into `REPLY`. Without `-r` a backslash escapes the next character and joins lines. `while IFS= read -r line; do ...; done < file` reads a file line by line, keeping whitespace.

## Options

- `-r` -- do not treat backslash as an escape
- `-s` -- do not echo input from a terminal
- `-a ARRAY` -- assign the fields to an indexed array
- `-d DELIM` -- stop at the first character of DELIM instead of a newline (empty: NUL)
- `-n COUNT` -- stop after COUNT characters
- `-t SECONDS` -- give up after SECONDS (may be fractional), with status 142; the kernel shell only
- `-p PROMPT` -- write PROMPT first, without a newline

## Examples

```
while IFS= read -r line; do echo "[$line]"; done < /etc/shells
```

## Exit status

0, or 1 at end of file.

## See also

`mapfile`, `select`, `@ecmaos/coreutils/ecmash`
