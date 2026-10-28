# truncate

`man @ecmaos/coreutils/truncate`

## Synopsis

```
truncate -s [+|-|<|>|/|%]SIZE [-c] [-o] FILE...
truncate -r RFILE [-s ADJUST] FILE...
```

## Description

Shrink or extend each FILE to a size. A file that is extended reads as zeros where it grew. A FILE that does not exist is created, unless `-c` is given.

SIZE takes the suffixes `K`, `M`, `G`... (powers of 1024) and `KB`, `MB`... (powers of 1000). A prefix changes what it means:

- `+` extends by SIZE, and `-` reduces by it
- `<` means at most SIZE, and `>` at least SIZE
- `/` rounds down to a multiple of SIZE, and `%` rounds up to one

`-r` takes the size from RFILE, and `-o` counts SIZE in 512-byte blocks.

## Options

```
  -c, --no-create        do not create any files
  -o, --io-blocks        treat SIZE as a number of 512-byte blocks
  -r, --reference=RFILE  base the size on RFILE
  -s, --size=SIZE        set or adjust the size
```

## See also

`fallocate`, `dd`
