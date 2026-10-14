# cat

`man @ecmaos/coreutils/cat`

## Synopsis

```
cat [OPTION]... [FILE]...
```

## Description

Concatenate FILE(s) to standard output. With no FILE, or when FILE is -, read standard input.

With no option the bytes are copied as they are read. `-E` shows a carriage return before a line feed as `^M`.

## Options

```
  -A, --show-all           equivalent to -vET
  -b, --number-nonblank    number nonempty output lines, overrides -n
  -e                       equivalent to -vE
  -E, --show-ends          display $ at the end of each line
  -n, --number             number all output lines
  -s, --squeeze-blank      suppress repeated empty output lines
  -t                       equivalent to -vT
  -T, --show-tabs          display TAB characters as ^I
  -u                       (ignored)
  -v, --show-nonprinting   use ^ and M- notation, except for LFD and TAB
  --help                   display this help and exit
```

## See also

`cat --help`
