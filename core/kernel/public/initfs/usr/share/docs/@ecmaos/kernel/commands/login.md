# login

`man @ecmaos/kernel/commands/login`

## Synopsis

```
/bin/login -t TTY USER
```

## Description

The second half of a login. `getty` asks for the user name and runs `login` with it on the terminal; you do not normally start it by hand.

It asks for the password with echo off (unless the user has a passkey that settles the login first), passes both to the kernel, which checks them and starts the session, prints `/etc/motd`, then runs the user's login shell on the terminal and waits for it:

- a shell that is a file, such as `/bin/ecmash`, is started as a login shell (`-ecmash`) in the user's home directory;
- the built-in `ecmaos` shell, which has no file, runs on the terminal until `exit` or `^D` on an empty line.

When the shell ends, the session is closed (the user leaves `who`) and `login` exits, so `getty` asks for a user name again. A wrong password prints the reason and exits with status 1. `^C` at the password prompt ends the attempt.

## Exit status

0 after a session that ended normally, 1 for a refused login, 2 for bad arguments.

## See also

`@ecmaos/kernel/commands/getty`, `@ecmaos/kernel/commands/chsh`
