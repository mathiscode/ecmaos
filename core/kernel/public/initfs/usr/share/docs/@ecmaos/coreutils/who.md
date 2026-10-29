# who

`man @ecmaos/coreutils/who`

## Synopsis

```
who [OPTION]
```

## Description

Print who is logged in, one console per line.

## Options

```
  -b, --boot   print the time of the last system boot
  -q, --count  print the login names and the number of users
  --help       display this help and exit

Reads /run/utmp. Each line is: NAME  LINE  TIME
```
