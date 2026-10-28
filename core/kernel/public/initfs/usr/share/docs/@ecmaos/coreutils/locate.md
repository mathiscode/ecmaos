# locate

`man @ecmaos/coreutils/locate`

## Synopsis

```
locate [OPTION]... PATTERN...
```

## Description

Print the files in the database `updatedb` made whose names match a pattern. A pattern with `*`, `?` or `[` is a glob that must match the whole path (or just the file name with `-b`); any other pattern matches when it is a part of the name. A path that matches any pattern is printed, or only one that matches all of them with `-A`. The database is a snapshot: a file made since the last `updatedb` is not in it, and one removed still is.

Exit status: 0 if something matched, 1 if nothing did, 2 for an error (no pattern, no database).

## Options

```
  -A, --all            only names that match all the patterns
  -b, --basename       match the file name part only
  -c, --count          print the number of matches
  -d, --database FILE  search FILE (default /var/lib/plocate/plocate.db)
  -i, --ignore-case    ignore case
  -l, -n, --limit N    stop after N matches
  -0, --null           separate matches with NUL
  -r, --regexp REGEX   match a regular expression
      --regex          read each PATTERN as a regular expression
  -w, --wholename      match the whole path (the default)
```

## Examples

```
updatedb
locate passwd
locate -b '*.md'
locate -c -i readme
```

## See also

`updatedb`, `find`, `which`
