# dos2unix

`man @ecmaos/coreutils/dos2unix`

## Synopsis

```
dos2unix [-fkqbmr] [-n INFILE OUTFILE]... [FILE]...
unix2dos [OPTIONS] [FILE]...
```

## Description

Convert line breaks between DOS (CR LF) and Unix (LF). `dos2unix` converts to Unix and `unix2dos` converts to DOS.

Files are converted in place: the result is written beside the file and renamed over it. With `-n`, each pair of names is converted from one file to the other. With no FILE, standard input is converted to standard output.

A file that looks binary is skipped unless `-f` is given. It looks binary when it has a NUL, or control characters other than tab, form feed, escape, CR and LF.

`dos2unix` removes a UTF-8 byte order mark and `unix2dos` keeps one. `-b` keeps it, `-r` removes it, and `-m` adds one.

## Options

```
  -b, --keep-bom    keep a byte order mark
  -f, --force       convert binary files too
  -k, --keepdate    keep the file's times
  -m, --add-bom     add a byte order mark
  -n, --newfile     convert INFILE to OUTFILE
  -o, --oldfile     convert in place (the default)
  -q, --quiet       say nothing
  -r, --remove-bom  remove a byte order mark
```

## See also

`tr`, `sed`
