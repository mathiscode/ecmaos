# fallocate

`man @ecmaos/coreutils/fallocate`

## Synopsis

```
fallocate [-n] [-o OFFSET] -l LENGTH FILE
fallocate -c|-i|-p|-z [-o OFFSET] -l LENGTH FILE
fallocate -d FILE
```

## Description

Give a file space, or change a range of it. Files here are not sparse, so allocating space writes it out. The modes are:

- default: extends a file shorter than OFFSET+LENGTH with zeros, unless `-n` keeps the size
- `-z`: writes zeros over the range
- `-p`: writes zeros over the range and keeps the size, since a punched hole reads as zeros
- `-c`: removes the range and moves the rest of the file down
- `-i`: inserts LENGTH zeros at OFFSET

`-d`, which looks for runs of zeros to free, finds nothing to free and leaves the file as it is. LENGTH and OFFSET take the suffixes `K`, `KiB`, `M` and so on.

## Options

```
  -c, --collapse-range  remove a range
  -d, --dig-holes       (nothing to do)
  -i, --insert-range    insert zeros
  -l, --length=N        the range's length
  -n, --keep-size       keep the file's size
  -o, --offset=N        where the range starts
  -p, --punch-hole      zero a range, keeping the size
  -z, --zero-range      zero a range
  -v, --verbose
```

## See also

`truncate`, `dd`
