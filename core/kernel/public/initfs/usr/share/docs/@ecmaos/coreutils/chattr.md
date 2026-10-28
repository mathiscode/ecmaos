# chattr

`man @ecmaos/coreutils/chattr`

## Synopsis

```
chattr [-RVf] [-+=aAcCdDeFijmPsStTux] FILE...
```

## Description

Change the attributes of files, as `lsattr` shows them: `+` adds the attributes named, `-` takes them away, and `=` makes them exactly those. `-R` changes directories and what is in them (symbolic links met on the way are passed by), `-V` says what each file's attributes became, and `-f` keeps quiet about most errors.

Two attributes are kept by the filesystem, for every user and root too:

- `i`, immutable: the file is not written, truncated, removed, renamed or linked to, and its mode, owner, times and extended attributes stay as they are. An immutable directory gains and loses no entries, though what is in it can still change.
- `a`, append-only: the file is only written at its end (`>>`, or a program that opens it with `O_APPEND`), and is not truncated, removed, renamed or linked to. An append-only directory gains entries but loses none.

Only root sets or clears `i` and `a`; the owner of a file may set the others. The others (`A`, `S`, `D`, `d`, `c`, `s`, `u`, `t`, `T` and the rest e2fsprogs knows) are kept and shown but change nothing here. They are the real `FS_IOC_SETFLAGS` and `FS_IOC_GETFLAGS` attributes, so programs that use those ioctls see them too.

## Examples

```
chattr +i /etc/resolv.conf
chattr +a /var/log/audit.log
chattr -R -i /srv/release
chattr =A notes.txt
```

## See also

`lsattr`, `chmod`
