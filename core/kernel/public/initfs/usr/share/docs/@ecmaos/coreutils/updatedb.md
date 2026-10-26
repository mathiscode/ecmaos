# updatedb

`man @ecmaos/coreutils/updatedb`

## Synopsis

```
updatedb [-v] [-U PATH] [-o FILE] [-e PATHS]
```

## Description

Walk the filesystem and write the list of file names `locate` searches, to `/var/lib/plocate/plocate.db` (made if needed, so run it as a user who may write there; root). Nothing runs it on a schedule: run it when `locate` should see new files, or add it to a crontab.

It does not enter `/proc`, `/sys`, `/dev`, `/run`, `/tmp`, `/media`, `/var/spool` or the database's own directory, which are not files or change by the second, and it does not follow symbolic links. A directory it cannot read is skipped. The database is written beside the old one and renamed over it, so a `locate` running meanwhile reads either whole.

## Options

```
  -U, --database-root PATH  scan from PATH instead of /
  -o, --output FILE         write to FILE
  -e, --prune-path PATHS    more directories not to enter (space separated)
  -v, --verbose             print each path as it is scanned
```

## See also

`locate`, `find`, `crontab`
