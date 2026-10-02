# dd

`man @ecmaos/kernel/commands/dd`

## Synopsis

```
dd [OPERAND]...
```

## Description

Copy a file, converting and formatting according to the operands.

## Options

```
Operands:

  if=FILE     read from FILE instead of stdin
  of=FILE     write to FILE instead of stdout
  bs=BYTES    read and write up to BYTES bytes at a time
  ibs=BYTES   read up to BYTES bytes at a time (default: 512)
  obs=BYTES   write BYTES bytes at a time (default: 512)
  count=N     copy only N input blocks
  skip=N      skip N input blocks before copying
  seek=N      skip N output blocks before copying
  conv=CONVS  convert the file as per the comma separated symbol list:
                ucase    convert to uppercase
                lcase    convert to lowercase
                swab     swap every pair of input bytes
                noerror  continue after read errors
                notrunc  do not truncate the output file
                sync     pad every input block to ibs

  status=LEVEL
              The LEVEL of information to print to stderr:
                'none'     suppress all output
                'noxfer'   suppress final transfer statistics
                'progress' show periodic transfer statistics

  --help      display this help and exit
```

## See also

`dd --help`
