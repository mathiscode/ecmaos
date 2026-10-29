# getfattr

`man @ecmaos/coreutils/getfattr`

## Synopsis

```
getfattr [-hRLP] [-n NAME|-d] [-e ENCODING] [-m PATTERN] PATH...
```

## Description

Show the extended attributes of files, as the attr package's `getfattr` does. Each file is a block that begins with `# file: PATH` and ends with a blank line, the form `setfattr --restore` reads back.

With no option it lists the names of the attributes that `-m` matches, `^user\.` by default (`-m -` matches every name). `-d` adds each one's value, and `-n NAME` shows one attribute; a file without it says `No such attribute`. A value is shown as a quoted string when it reads as text and in base64 (`0s...`) when it does not; `-e text`, `-e hex` (`0x...`) or `-e base64` chooses. `--only-values` writes the bare values with nothing around them.

Paths are shown without their leading `/`, which is said once on standard error, unless `--absolute-names`. `-h` reads a symbolic link's own attributes, and `-R` goes down into directories (`-L` following links to directories as it goes, `-P` not).

Attributes in the `user.` namespace are the ones a file can be given; `chattr` keeps the flags that have no inode bit in `system.ecmaos.chattr`.

## Examples

```
getfattr -d notes.txt
getfattr -n user.comment -e hex notes.txt
getfattr -R -d -m - /srv > attrs.dump
```

## See also

`setfattr`, `lsattr`
