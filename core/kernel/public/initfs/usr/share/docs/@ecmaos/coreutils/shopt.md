# shopt

`man @ecmaos/coreutils/shopt`

## Synopsis

```
shopt [-pqsu] [NAME ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Shows or changes bash-style shell options. Those that change what the shell does: `nullglob` (a pattern with no match expands to nothing), `failglob` (it is an error), `dotglob` (wildcards match a leading dot), `nocaseglob`, `nocasematch` (ignore case in pathnames, and in `case` and `[[`), `extglob` (`@(a|b)`, `?(..)`, `*(..)`, `+(..)`, `!(..)`) and `globstar` (`**` matches any number of directories). `checkwinsize`, `cmdhist`, `histappend`, `huponexit` and `progcomp` are accepted and remembered. Any other name is an error.

## Options

- `-s` - turn each NAME on
- `-u` - turn each NAME off
- `-q` - print nothing; the status says whether every NAME is on
- `-p` - print in a form that can be read back

## Examples

```
shopt -s nullglob extglob
```

## Exit status

0, or 1 when an option is off (`-q`) or unknown.

## See also

`set`
