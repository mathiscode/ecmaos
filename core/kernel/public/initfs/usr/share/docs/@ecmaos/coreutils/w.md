# w

`man @ecmaos/coreutils/w`

## Synopsis

```
w [-hs] [USER]
```

## Description

Shows who is logged in and what the machine is doing. The first line is the time, how long the machine has been up, how many logins there are, and the load averages; then there is a line for each console with a login, read from `/run/utmp` (the same file `who` reads). `-h` leaves out the headers, `-s` the login time and CPU columns, and a `USER` limits the lines to that user.

FROM is `-` and WHAT is `-`: a login is a console on this machine, and the kernel does not say what a terminal's foreground program is. The CPU columns are 0.00s since the browser does not measure them.

## Examples

```
w
w -h root
```

## See also

`@ecmaos/coreutils/who`, `@ecmaos/coreutils/last`, `@ecmaos/coreutils/uptime`
