# profile

`man @ecmaos/kernel/commands/profile`

## Synopsis

```
profile [show]
profile list
profile set [-y] [--offline] NAME
```

## Description

A machine keeps one of four sets of ecmaOS's programs, its profile: `minimal` (the kernel's own commands, bash, compression, system utilities and an SSH client), `standard` (the default: editors, text and data tools, tmux and screen, monitors, hardware tools and manual pages), `developer` (Standard plus python3, perl, ripgrep and the other developer tools) and `everything`. The profile is recorded in `/etc/ecmaos/profile` the first time the machine boots; a machine that already had programs becomes `everything`, so nothing it has is taken away.

`profile` shows the profile and `profile list` lists them. `profile set NAME` (root) changes it. Going to a smaller profile lists the programs the bigger one brought, which are removed after you confirm (`-y` skips the question); a program you installed by name stays. Going to a bigger one records the choice and installs what the registry has; whatever the site's catalog carries is installed at the next boot. `--offline` leaves all of it to the next boot.

The profile is the one package installed by name (`@ecmaos-apps/profile-standard`), made of groups (`@ecmaos-apps/group-editors`) made of programs: `install remove` of a group member keeps it out, `install autoremove` after removing the profile takes the rest.

## See also

`install(1)`, `command-not-found(1)`
