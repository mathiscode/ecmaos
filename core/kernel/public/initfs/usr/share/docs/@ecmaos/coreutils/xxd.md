# xxd

`man @ecmaos/coreutils/xxd`

## Synopsis

```
xxd [options] [infile]
```

## Description

Make a hex dump of INFILE, or of standard input (also when INFILE is `-`). Each line is an offset, the bytes in hex, and their ASCII.

The input is dumped as it is read, so a file that never ends is dumped for ever unless `-l` says where to stop: `xxd -l 16 /dev/urandom` prints one line.

## Options

```
  -c cols    format <cols> octets per line (default 16; 30 with -p)
  -g bytes   group <bytes> octets per group (default 2; 0 for no grouping)
  -l len     stop after <len> octets
  -p         plain hex dump, with no offsets or ASCII
  -s seek    start at <seek> bytes into the input (the offsets shown start there)
  -u         use upper case hex letters
  -h         display this help and exit
```

Numbers may be decimal, `0x` hex or leading-0 octal. Text that is not a number is 0, as with `strtol`. Not implemented: `-r` (reverse), `-i` (C include), `-b` (bits), `-e`, `-E`, `-a`, `-o`, `-d`, `-R`, and an output file argument.

## Exit status

2 if INFILE cannot be read or is a directory, 1 for an option it does not know, otherwise 0.
