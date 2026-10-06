# passwd

`man @ecmaos/kernel/commands/passwd`

## Synopsis

```
passwd [OLD NEW]
passwd -l|-u|-S LOGIN
```

## Description

Changes the current user's password. Without arguments, prompts interactively for the current password and the new one, with terminal echo turned off while a password is being typed (`echoOff(0)`, restored afterward).

Password hashes are stored separately from `/etc/passwd`, in `/etc/shadow` (`0640 root:shadow`), whose lines have the Linux layout `name:hash:lastchg:min:max:warn:inactive:expire:reserved`. A hash is `$pbkdf2-sha256$rounds$salt$hash`; hashes in the older forms still work and are replaced at the next login. `/etc/passwd` itself is the real 7-field Linux format (`name:x:uid:gid:gecos:home:shell`), with the password field always `x`, and supplementary group membership lives in `/etc/group`.

A password change records the day in the `lastchg` field, is refused for a user until `min` days have passed since the last one (an administrator is not held to it), and re-encrypts the private key in `~/.ssh/id_ecdsa` if there is one.

With `-l`, `-u` or `-S`, root works on another account's password. Only root may.

## Options

- `-l, --lock` -- lock the password: a `!` goes before the hash, and the password no longer logs in. A passkey still does; `chage -E` closes the account entirely
- `-u, --unlock` -- take the `!` away. Refused when that would leave an account with no password
- `-S, --status` -- print `LOGIN STATE LASTCHANGE MIN MAX WARN INACTIVE`; the state is `L` (locked, or `*`), `P` (a usable password) or `NP` (none)
- `--help` -- display usage and exit

## Notes

New passwords are validated: non-empty, a minimum length, and rejected if they contain `:` or a newline (both would corrupt the `/etc/passwd`/`/etc/group` colon-delimited format if a raw password ever ended up written there by mistake).

## See also

`/etc/passwd`, `/etc/shadow`, `/etc/group`, `@ecmaos/kernel/commands/chage`, the `user` command
