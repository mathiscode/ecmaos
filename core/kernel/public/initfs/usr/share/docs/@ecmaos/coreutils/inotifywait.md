# inotifywait

`man @ecmaos/coreutils/inotifywait`

## Synopsis

```
inotifywait [-mqrc] [-e EVENT]... [-t SECONDS] [--format FMT] [--timefmt FMT] [-o FILE] FILE...
```

## Description

Wait for files to change. Each FILE, a file or a directory, is watched through the kernel's file watches. The events that can be seen are:

- `MODIFY`: a file was written
- `CREATE` and `DELETE`: an entry was made or removed in a watched directory, with `ISDIR` added for a directory
- `DELETE_SELF`: a watched file was removed

A rename shows as a `DELETE` of the old name and a `CREATE` of the new one, not as `MOVED_FROM` and `MOVED_TO`. Nothing is seen for opening, reading, closing, or a change of mode or owner. Asking with `-e` only for events that cannot be seen is an error, and asking for some of them gives a warning.

Each event is printed as `DIR EVENTS FILE`, or as `--format` gives it (`%w`, `%f`, `%e`, `%Xe`, `%T`), or as CSV with `-c`. Without `-m`, inotifywait ends after the first event with status 0, or when `-t` runs out with status 2. `-r` also watches everything under a directory.

## Options

```
  -c, --csv            CSV output
  -e, --event EVENT    modify, create, delete, delete_self
      --exclude RE     skip files matching RE (--excludei: ignoring case)
      --include RE     only files matching RE
      --format FMT     %w %f %e %Xe %T
      --fromfile FILE  read the names to watch from FILE
  -m, --monitor        keep waiting
  -o, --outfile FILE   append events to FILE
  -q, --quiet          once: no setup messages; twice: nothing
  -r, --recursive      watch below directories too
  -t, --timeout SECS   give up after SECS
      --timefmt FMT    strftime format for %T
```

## See also

`watch`, `tail -f`
