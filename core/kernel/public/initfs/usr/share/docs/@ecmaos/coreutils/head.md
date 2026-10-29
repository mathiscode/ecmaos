# head

`man @ecmaos/coreutils/head`

## Synopsis

```
head [OPTION]... [FILE]...
```

## Description

Print the first 10 lines of each FILE to standard output. With more than one FILE, precede each with a header giving its name. With no FILE, or when FILE is -, read standard input.

The bytes are passed through untouched: a last line with no newline stays without one. A positive count is read only as far as it needs, so `head -c 16 /dev/urandom` returns.

## Options

```
  -c, --bytes=[-]NUM   print the first NUM bytes of each file; with -NUM, print all but the last NUM bytes
  -n, --lines=[-]NUM   print the first NUM lines instead of the first 10; with -NUM, print all but the last NUM lines
  -q, --quiet          never print headers giving file names
  -v, --verbose        always print headers giving file names
  -NUM                 the same as -n NUM
  --help               display this help and exit

NUM may have a multiplier suffix: b 512, kB 1000, K 1024, MB 1000*1000, M 1024*1024, GB, G, TB, T.
```
