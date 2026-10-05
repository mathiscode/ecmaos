# getty

`man @ecmaos/coreutils/getty`

## Synopsis

```
/sbin/getty ttyN
```

## Description

The login prompt on one terminal. `init` runs one for each terminal from `/etc/inittab`; you do not normally start it by hand.

It prints `/etc/issue`, asks for a user name, and runs `/bin/login` with it on the terminal. `login` asks for the password, starts the session and runs the user's shell (see `@ecmaos/coreutils/login`). When `login` returns, whether the user logged out or the login was refused, getty asks for a user name again. `^C` at the prompt is ignored.

## Terminal

`N` is the terminal number, 0 to 7, as in `Ctrl+Shift+<N>`. An `/etc/inittab` entry whose id is `ttyN` is run by init with that terminal as its controlling terminal, and the terminal is created if it does not exist yet:

```
tty2::respawn:/sbin/getty tty2
```

## When there is no getty

A kernel started with credentials (`options.credentials`: tests, kiosks and embeds) logs that user in itself and runs no getty. So does one whose `/etc/inittab` has no `getty` entry for the first terminal: the kernel shows its own login prompt, as earlier releases did.

## See also

`@ecmaos/coreutils/login`, `@ecmaos/coreutils/inittab`, `@ecmaos/coreutils/init`, `@ecmaos/kernel/commands/chsh`
