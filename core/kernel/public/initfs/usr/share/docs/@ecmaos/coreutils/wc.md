# wc

`man @ecmaos/coreutils/wc`

## Synopsis

```
wc [OPTION]... [FILE]...
```

## Description

Print newline, word, and byte counts for each FILE, and a total line if more than one FILE is given. With no FILE, or when FILE is `-`, read standard input.

The input is counted as it is read, in constant memory, so a very large file works. A file that never ends, such as `/dev/zero`, is counted for ever, as on Linux.

The counts are lined up as GNU `wc` does: one count of one input is printed bare, otherwise the columns are as wide as the sum of the sizes of the regular files, or 7 when an input is a pipe or a device. Unlike GNU `wc`, a standard input redirected from a file (`wc < file`) counts as a pipe, so it gets the width 7.

## Options

```
  -c, --bytes            print the byte counts
  -m, --chars            print the character counts (valid UTF-8 sequences)
  -l, --lines            print the newline counts
  -L, --max-line-length  print the maximum display width (a tab goes to the next multiple of 8)
  -w, --words            print the word counts
  --help                 display this help and exit
```

The counts are printed in the order lines, words, characters, bytes, longest line.

## Exit status

1 if a file cannot be read or is a directory (the other files are still counted), otherwise 0.

## See also

`wc --help`
