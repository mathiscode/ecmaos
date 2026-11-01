# finger

`man @ecmaos/coreutils/finger`

## Synopsis

```
finger [-lmps] [login ...]
```

## Description

Shows who is logged in (from `/run/utmp`) as a table, or, given names, the long entry for each account: its real name, home directory and shell, whether it is logged in, otherwise its latest login from `/var/log/wtmp`. `-s` forces the short table, `-l` the long form, `-m` matches login names only and `-p` leaves out the home directory, shell and plan. There is no mail or `.plan` handling, so those lines are always "No mail." and "No Plan.".

## Examples

```
finger
finger root
finger -s root
```

## See also

`@ecmaos/coreutils/pinky`, `@ecmaos/coreutils/who`, `@ecmaos/coreutils/last`

## License

MIT OR Apache-2.0.
