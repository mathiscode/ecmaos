# tail

`man @ecmaos/coreutils/tail`

## Synopsis

```
tail [OPTION]... [FILE]...
```

## Description

Print the last 10 lines of each FILE to standard output, with a header naming each file when there is more than one. With no
FILE, or `-`, read standard input. It works on bytes, so binary data passes through unchanged.

## Options

```
  -c, --bytes=[+]NUM   output the last NUM bytes; with +NUM, start at byte NUM of each file
  -n, --lines=[+]NUM   output the last NUM lines, instead of 10; with +NUM, start at line NUM
  -q, --quiet          never print headers giving file names
  -v, --verbose        always print headers giving file names
  --help               display this help and exit
```

NUM may end in `b` (512), `k` (1024) or `m` (1048576). `-NUM` is the old spelling of `-n NUM`. There is no `-f`.

## See also

`head`, `tail --help`
