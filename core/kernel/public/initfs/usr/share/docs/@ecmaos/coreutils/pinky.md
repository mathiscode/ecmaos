# pinky

`man @ecmaos/coreutils/pinky`

## Synopsis

```
pinky [-lbfwiq] [user ...]
```

## Description

The short form of `finger`, with the GNU options: the table of logged-in users (login, name, terminal, idle time, login time), or with `-l` the long entry per user. `-f` leaves out the header, `-w`, `-i` and `-q` drop the name, remote host and idle columns, `-b` the home directory and shell in the long form.

## Examples

```
pinky
pinky -f
pinky -l root
```

## See also

`@ecmaos/coreutils/finger`, `@ecmaos/coreutils/who`

## License

MIT OR Apache-2.0.
