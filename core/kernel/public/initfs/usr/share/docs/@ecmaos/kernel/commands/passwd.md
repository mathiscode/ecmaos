# passwd

`man @ecmaos/kernel/commands/passwd`

## Synopsis

```
passwd [OLD NEW]
```

## Description

Changes the current user's password. Without arguments, prompts interactively for the current password and the new one, with terminal echo turned off while a password is being typed (`echoOff(0)`, restored afterward).

Password hashes are stored separately from `/etc/passwd` (see `lib/credentials.ts`); `/etc/passwd` itself is the real 7-field Linux format (`name:x:uid:gid:gecos:home:shell`), with the password field always `x`, and supplementary group membership lives in `/etc/group`.

## Options

- `--help` -- display usage and exit

## Notes

New passwords are validated: non-empty, a minimum length, and rejected if they contain `:` or a newline (both would corrupt the `/etc/passwd`/`/etc/group` colon-delimited format if a raw password ever ended up written there by mistake).

## See also

`/etc/passwd`, `/etc/group`, the `user` command
