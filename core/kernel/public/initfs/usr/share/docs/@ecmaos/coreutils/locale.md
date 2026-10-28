# locale

`man @ecmaos/coreutils/locale`

## Synopsis

```
locale
locale -a | -m
locale [-c] [-k] NAME...
```

## Description

Show the locale settings in effect: `LANG`, each `LC_*` category, and `LC_ALL`. A category with no setting of its own is shown in quotes, with the value it takes from `LC_ALL` or `LANG`.

`-a` lists the locales there are: `C`, `C.utf8`, `POSIX`, and those in `/usr/share/i18n/SUPPORTED`. `-m` lists the character maps.

A NAME is a keyword or a category, and the value is shown. The keywords are `charmap`, `codeset`, `decimal_point`, `thousands_sep`, `grouping`, `d_t_fmt`, `d_fmt`, `t_fmt`, `yesexpr` and `noexpr`. A category shows each of its keywords. `-c` names the category, and `-k` names each keyword.

Every locale here but `C` and `POSIX` is UTF-8, and all of them format numbers and dates as `C` does.

## See also

`localectl`
