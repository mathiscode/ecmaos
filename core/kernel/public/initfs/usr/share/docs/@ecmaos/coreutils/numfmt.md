# numfmt

`man @ecmaos/coreutils/numfmt`

## Synopsis

```
numfmt [OPTION]... [NUMBER]...
```

## Description

Convert numbers to and from human-readable sizes, as GNU numfmt does. With no NUMBER, the numbers come from standard input: the first field of each line, or the fields `--field` names.

`--to=si` scales by 1000 (`1.5k`, `124k`, `1.1M`). `--to=iec` scales by 1024 (`1.5K`), and `--to=iec-i` writes `Ki`, `Mi` and so on. `--from` reads the same suffixes back, and `--from=auto` takes `K` as 1000 and `Ki` as 1024.

A scaled number below ten keeps one decimal. Rounding is away from zero unless `--round` says otherwise. An invalid number stops the run with status 2, unless `--invalid` says otherwise. In the C locale, `--grouping` changes nothing.

## Options

```
  -d, --delimiter=X     the field delimiter (default: blanks)
      --field=FIELDS    the fields to convert: N, N-M, N-, -M, lists
      --format=FORMAT   printf-style %f with flags, width and precision
      --from=UNIT       none, auto, si, iec, iec-i
      --from-unit=N     the input unit size
      --header[=N]      leave the first N lines alone
      --invalid=MODE    abort, fail, warn or ignore
      --padding=N       pad to N characters (negative: on the right)
      --round=METHOD    up, down, from-zero, towards-zero, nearest
      --suffix=SUFFIX   add (and accept) a suffix
      --to=UNIT         none, si, iec, iec-i
      --to-unit=N       the output unit size
  -z, --zero-terminated  lines end with NUL
```

## See also

`df -h`, `du -h`
