# visudo

`man @ecmaos/coreutils/visudo`

## Synopsis

```
visudo [-chqs] [-f FILE]
```

## Description

Edits `/etc/sudoers` safely. The file is copied to `/etc/sudoers.tmp`, the copy is edited with `$SUDO_EDITOR`, `$VISUAL`, `$EDITOR` or `vim`, and it is checked with the parser `sudo` itself uses; only a sound file is installed (mode 0440), so a typo cannot lock everyone out of `sudo`. When the edited file has errors `visudo` asks what to do: `e` edits it again, `x` leaves without saving, `Q` saves it anyway.

## Options

- `-c, --check`: check the file and exit, without editing
- `-f, --file=FILE`: the file to edit (default `/etc/sudoers`)
- `-q, --quiet`: with `-c`, print nothing when the file is fine
- `-s, --strict`: also treat constructs that are not supported as errors

## Notes

A rule `sudo` does not understand is an error. A construct that is valid sudoers but not supported here (a `User_Alias`, `#include`) is noted and does not stop the save, unless `-s`. Only root may run it.

## Exit status

0 when the file was installed, unchanged, or is fine; 1 on an error, or when no changes were made.

## See also

`@ecmaos/coreutils/sudo`, `@ecmaos/coreutils/sudoers`
