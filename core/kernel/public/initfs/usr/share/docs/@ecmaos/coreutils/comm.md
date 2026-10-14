# comm

`man @ecmaos/coreutils/comm`

## Synopsis

```
comm [OPTION]... FILE1 FILE2
```

## Description

Compare sorted files FILE1 and FILE2 line by line.

## Options

```
  -1                      suppress column 1 (lines unique to FILE1)
  -2                      suppress column 2 (lines unique to FILE2)
  -3                      suppress column 3 (lines that appear in both files)
  --check-order           check that the input is correctly sorted, even if all input lines are pairable
  --nocheck-order         do not check that the input is correctly sorted
  --output-delimiter=STR  separate columns with STR
  --total                 output a summary
  -z, --zero-terminated   line delimiter is NUL, not newline
  --help                  display this help and exit

With no FILE, or when FILE is -, read standard input.
```

## See also

`comm --help`
