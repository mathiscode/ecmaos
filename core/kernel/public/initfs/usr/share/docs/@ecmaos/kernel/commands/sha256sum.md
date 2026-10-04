# sha256sum

`man @ecmaos/kernel/commands/sha256sum`

## Synopsis

```
sha256sum [OPTION]... [FILE]...
```

## Description

Prints or checks SHA-256 checksums. With no FILE, or when FILE is `-`, it reads standard input. Each line of output is the sum, a space, a space or `*` (binary mode), and the file name; `-c` reads such lines back and reports `OK` or `FAILED` for each file.

## Options

- `-b, --binary`: read in binary mode (the output marks it with `*`)
- `-t, --text`: read in text mode (the default)
- `-c, --check`: read sums from the FILEs and check them
- `--tag`: create a BSD-style checksum line
- `--quiet`: when checking, do not print OK for files that pass
- `--status`: when checking, print nothing; the status says whether they passed

## Exit status

0 when every sum was produced or matched, 1 otherwise.

## See also

`@ecmaos/kernel/commands/hash`, `@ecmaos/kernel/commands/base64`
