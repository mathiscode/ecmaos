# diff3

`man @ecmaos/coreutils/diff3`

## Synopsis

```
diff3 [-m [-A | -E]] [-L LABEL]... MINE OLDER YOURS
```

## Description

Compare three files line by line, where OLDER is the ancestor of MINE and YOURS. It uses the same comparison as `diff`, so blocks fall where GNU diff3's do.

By default it lists the blocks in which the files differ. A block starts with `====` (all three differ), `====1` (only MINE differs), `====2` (only OLDER differs) or `====3` (only YOURS differs), then gives each file's range (`N:3c` one line, `N:3,5c` several, `N:3a` an empty range after line 3) and the lines of the files that need showing, indented by two spaces. Of two files that agree, the first has only its range.

With `-m` the merged file is written instead: changes only one side made are taken, and where both sides changed the same lines the block is bracketed with `<<<<<<<`, `|||||||` (OLDER), `=======` and `>>>>>>>`, labelled with the file names or `-L`. `-m -E` leaves out the OLDER lines and does not bracket a change both sides made.

Exit status: 0, or 1 when `-m` found a conflict, or 2 for trouble such as an unreadable file.

## Options

```
  -m, --merge          write the merged file
  -A, --show-all       with -m, bracket conflicts and show OLDER (the default of -m)
  -E, --show-overlap   with -m, bracket conflicts without OLDER
  -L, --label=LABEL    a label in place of a file name (up to three)
  -a, --text           accepted; files are compared as text
```

The ed script forms (`-e`, `-x`, `-3`, `-X`, `-i`) are not provided and are refused. A FILE of `-` reads standard input, for one file.

## Examples

```
diff3 mine.txt base.txt theirs.txt
diff3 -m -L mine -L base -L theirs a b c > merged.txt
```

## See also

`diff`, `patch`, `git`
