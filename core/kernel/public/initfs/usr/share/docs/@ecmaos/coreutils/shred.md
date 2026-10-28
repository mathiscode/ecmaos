# shred

`man @ecmaos/coreutils/shred`

## Synopsis

```
shred [-fuvxz] [-n N] [-s SIZE] FILE...
```

## Description

Overwrite each FILE so its contents are hard to recover. Each of the `-n` passes (3 by default) writes random bytes over the file's length, rounded up to 4 KiB blocks unless `-x` is given. `-z` adds a final pass of zeros, so the shredding is less obvious.

`-u` then empties the file, renames it to shorter and shorter names made of zeros, and removes it. A FILE of `-` shreds standard output.

GNU's page warns that a journaling filesystem may keep copies of old data. The same applies here: the browser's IndexedDB, where files are kept, may hold old copies of what was overwritten. So this is a best effort.

## Options

```
  -f, --force       make the file writable if need be
  -n, --iterations  passes of random data (3)
  -s, --size=SIZE   shred this many bytes
  -u                remove the file afterwards
  -v, --verbose     show each pass
  -x, --exact       do not round up to whole blocks
  -z, --zero        a last pass of zeros
```

## See also

`rm`
