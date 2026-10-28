# lsattr

`man @ecmaos/coreutils/lsattr`

## Synopsis

```
lsattr [-RVadlv] [FILE...]
```

## Description

List the attributes `chattr` sets: a letter for each one a file has, in e2fsprogs's order (`suSDiadAcEjItTeCxFNPVm`), and `-` for each it has not, then the file's name. With no file it lists the current directory. A directory named is listed by what is in it unless `-d` asks for the directory itself; `-a` includes the names that begin with `.`, `-R` goes down into directories, and `-l` writes the attributes' names (`Immutable`, `Append_Only`) instead of their letters. `-v` adds the file's generation, which is always 0 here.

## Examples

```
lsattr /etc/resolv.conf
lsattr -d /srv
lsattr -R -a ~
```

## See also

`chattr`
