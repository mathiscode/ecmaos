# sudoedit

`man @ecmaos/coreutils/sudoedit`

## Synopsis

```
sudoedit [-n] [-S] FILE...
sudo -e FILE...
```

## Description

Edit files that only root may write, without running the editor as root. For each file, `sudoedit` checks `/etc/sudoers` (the rule's command is the word `sudoedit`, or `ALL`), asks for the caller's own password as `sudo` does, copies the file to a temporary file in `/tmp` that the caller owns, runs the caller's editor on the copy as the caller, and, if the copy changed, writes it back to the file as root. The file's owner and mode are kept; a file that does not exist is made (mode 0644) if the editor leaves something in it. The temporary file is removed.

The editor is `SUDO_EDITOR`, `VISUAL` or `EDITOR` (a program with arguments), else the first of `nano`, `vim`, `vi` and `ed` that is installed. If it exits with a failure the file is not changed.

For safety a file in a directory the caller can write to (so `/tmp` and a home directory) is refused, as is a symbolic link: otherwise the caller could change which file is meant between the copy and the write-back. Only root can be edited as (`-u` is not provided).

`sudoedit` is the same program as `sudo`; it has the setuid bit like `sudo`.

## Options

```
  -n  never ask for a password; fail if one is needed
  -S  read the password from standard input
```

## See also

`sudo`, `su`, `visudo`
