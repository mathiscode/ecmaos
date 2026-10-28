# lslocks

`man @ecmaos/coreutils/lslocks`

## Synopsis

```
lslocks [-bJnru] [-o COLUMNS] [-p PID]
```

## Description

List the file locks held now, from `/proc/locks`. Each lock's file is found among its owner's open files by inode. A file its owner no longer has open shows no path.

The locks are the kernel's record locks, taken by `fcntl`, `lockf` and `flock`, so every TYPE is POSIX and every lock is advisory (M is 0). An END of 0 means the lock runs to the end of the file.

## Options

```
  -b, --bytes        sizes in bytes
  -J, --json         JSON
  -n, --noheadings   no header line
  -o, --output LIST  COMMAND,PID,TYPE,SIZE,INODE,MAJ:MIN,MODE,M,START,END,PATH,BLOCKER (+LIST adds to the default)
      --output-all   every column
  -p, --pid PID      only this process's locks
  -r, --raw          raw output
```

## See also

`flock`, `fuser`, `/proc/locks`
