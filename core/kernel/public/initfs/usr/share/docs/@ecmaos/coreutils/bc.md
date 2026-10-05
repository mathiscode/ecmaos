# bc

`man @ecmaos/coreutils/bc`

## Synopsis

```
bc [-l] [-q] [-s] [-w] [-e EXPR] [FILE]...
dc [-e EXPR] [-f FILE]...
```

## Description

`bc`, the arbitrary-precision calculator language (Gavin Howard's implementation, POSIX bc with GNU extensions),
built to WebAssembly and run as an ordinary program. With no file it reads expressions from standard input;
on a terminal it prompts, with line editing and history on the arrow keys. `dc`, its reverse-Polish sibling, is
the same program under another name (`/bin/dc` is a link to `/bin/bc`).

Numbers have as many digits as you ask for: `scale=30; 4*a(1)` prints pi to 30 places with the math library
(`-l`, which also sets `scale=20`). Variables, arrays, functions, `if`/`while`/`for`, `ibase`/`obase`, and the
extras `$` (truncate), `@` (set places) and `r(x, p)` (round) are all there.

## Options

`-l` load the math library (`s`, `c`, `a`, `l`, `e`, `j`) and set `scale=20`, `-q` no banner, `-s` strict POSIX
mode, `-w` warn on non-POSIX use, `-e EXPR` run an expression (repeatable), `-f FILE` run a file.

Exit status: 0 on success, non-zero on a syntax or runtime error (the message goes to standard error).

## Examples

```
echo '2^100' | bc
echo 'scale=20; sqrt(2)' | bc
bc -l <<< 'e(1)'
echo '2 3 + 4 * p' | dc
```

## License

Gavin Howard's bc 7.0.3, BSD-2-Clause. The license text is in `/usr/share/licenses/@ecmaos/coreutils/bc/`.
