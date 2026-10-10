# top

`man @ecmaos/kernel/commands/top`

## Synopsis

```
top [-b] [-n COUNT] [-d SECONDS]
```

## Description

Show the running processes and the memory the browser reports, redrawn every few seconds until `q`. Columns are the process id, its parent, its user and its command, all read from `/proc`. There is no `%CPU` column and no sort by load: a browser does no CPU accounting, so there is nothing true to show. When output is not a terminal, or with `-b`, one screen after another is printed instead of redrawn, which is how a script uses it.

## Options

```
  -b           batch mode: print the screen one after another instead of redrawing
  -n COUNT     stop after COUNT screens
  -d SECONDS   delay between screens (default 3)
  --help       display this help and exit

Keys: q or ^C quits, space redraws now.
```

## See also

`ps`, `free`, `kill`
