# wall

`man @ecmaos/coreutils/wall`

## Synopsis

```
wall [-n] [MESSAGE]
```

## Description

Write MESSAGE, or standard input, to every terminal that has someone logged in (the lines of `/run/utmp`, as `who` shows them), each ecmaOS terminal being one of the eight consoles. A terminal that ran `mesg n` is skipped, unless root runs `wall`.

## Options

```
  -n      do not print the banner line
  --help  display this help and exit
```

## See also

`write`, `who`
