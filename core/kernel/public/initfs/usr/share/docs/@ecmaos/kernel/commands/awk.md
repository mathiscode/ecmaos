# awk

`man @ecmaos/kernel/commands/awk`

## Synopsis

```
awk [OPTION]... 'program' [FILE]...
```

## Description

Pattern scanning and text processing language.

## Options

```
  -F, --field-separator=FS   set field separator (default: whitespace)
  -v, --assign=VAR=VAL        assign variable VAR to value VAL
  --help                     display this help and exit

Basic usage:
  awk '{ print $1 }' file              Print first field of each line
  awk '/pattern/ { print }' file        Print lines matching pattern
  awk 'BEGIN { print "start" } { print } END { print "end" }' file

Variables:
  $0    whole line
  $1, $2, ...  field numbers
  NR    record number (line number)
  NF    number of fields
```

## See also

`awk --help`
