# patch

`man @ecmaos/kernel/commands/patch`

## Synopsis

```
patch [-Rlsuv] [-d DIR] [-i FILE] [-p DEPTH] [-F FUZZ] [--dry-run] [FILE [PATCH]]
```

## Description

Applies a unified diff, from toybox 0.8.12 (not GNU patch). Only unified format is understood, which is what `diff -u` and `git diff` write. A file is changed only when all of its hunks apply; failed hunks are printed on standard error and the exit status is non-zero. `--dry-run` checks without writing, `-R` reverses a patch.

## Examples

```
diff -u old.c new.c > fix.diff
patch old.c < fix.diff
patch -p1 -i changes.diff
patch -R -p1 < changes.diff
```

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/patch/`.
