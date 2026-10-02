# getty

`man @ecmaos/kernel/commands/getty`

## Synopsis

```
/sbin/getty ttyN
```

## Description

The login prompt on one terminal. `init` runs one for each terminal from `/etc/inittab`; you do not normally start it by hand.

It prints `/etc/issue`, asks for a user name, then a password with echo off, and passes them to the kernel, which checks them (trying a passkey first when the user has one, since that needs the page) and starts the session. Then it runs the user's login shell on the terminal and waits for it:

- a shell that is a file, such as `/bin/ecmash`, is started as a login shell (`-ecmash`) in the user's home directory;
- the built-in `ecmaos` shell, which has no file, runs on the terminal until `exit` or `^D` on an empty line.

When the shell ends, the session is closed (the user leaves `who`) and the prompt comes back. A wrong password prints the reason and asks again. `^C` at the prompt is ignored.

The terminals other than the first also print `/etc/motd` after a login. The first prints it from `/boot/init`.

## Terminal

`N` is the terminal number, 0 to 7, as in `Ctrl+Shift+<N>`. An `/etc/inittab` entry whose id is `ttyN` is run by init with that terminal as its controlling terminal, and the terminal is created if it does not exist yet:

```
tty2::respawn:/sbin/getty tty2
```

## When there is no getty

A kernel started with credentials (`options.credentials`: tests, kiosks and embeds) logs that user in itself and runs no getty. So does one whose `/etc/inittab` has no `getty` entry for the first terminal: the kernel shows its own login prompt, as earlier releases did.

## See also

`@ecmaos/kernel/commands/inittab`, `@ecmaos/kernel/commands/init`, `@ecmaos/kernel/commands/chsh`
