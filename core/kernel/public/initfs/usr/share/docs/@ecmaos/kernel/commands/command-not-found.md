# command-not-found

`man @ecmaos/kernel/commands/command-not-found`

## Synopsis

```
command-not-found COMMAND...
```

## Description

Says which package provides a command this system does not have, as Debian's does. The shells run it after `COMMAND: command not found`, so a missing `figlet` is answered with

```
Command 'figlet' not found, but can be installed with:
  sudo install -g @ecmaos-apps/figlet
```

and a name that is only another name for a program's command (`unxz`) says which package it is part of. It reads the package index (the one `apt update` fetched, else the copy in `/usr/share/ecmaos/package-index`), makes no request, prints on standard error and ends with status 127; it never installs anything. Nothing is printed for a command the index does not know.

The ecmaos shell and `ecmash` call it by themselves, in scripts too (the hint follows the command's `2>` redirection). `bash` calls `command_not_found_handle` when it is defined, which `~/.bashrc` from `/etc/skel` does.

## See also

`install(1)`, `apt(1)`
