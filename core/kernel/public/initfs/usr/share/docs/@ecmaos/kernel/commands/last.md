# last

`man @ecmaos/kernel/commands/last`

## Synopsis

```
last [-n NUM] [USER]...
```

## Description

Show the logins recorded in /var/log/wtmp, newest first.

## Options

```
  -n, --limit NUM  show at most NUM lines
  --help           display this help and exit

A session ends at the next system boot, since a console has no logout to record: the page
closing is not something that can write a line. The current boot's logins read "still logged in".
```

## See also

`last --help`
