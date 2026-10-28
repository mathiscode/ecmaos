# sum

`man @ecmaos/coreutils/sum`

## Synopsis

```
sum [-r|-s] [FILE]...
```

## Description

Print the 16-bit checksum and size of each FILE, or of standard input. `-r` (the default) uses the BSD algorithm and counts the size in 1024-byte blocks. `-s` uses the System V algorithm and counts the size in 512-byte blocks.

## Options

```
  -r          BSD algorithm
  -s, --sysv  System V algorithm
```

## See also

`cksum`, `md5sum`
