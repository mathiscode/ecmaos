# setfacl

`man @ecmaos/coreutils/setfacl`

## Synopsis

```
setfacl [-bkndRLP] { -m|-M|-x|-X|--set ... } file ...
```

## Description

Changes the access control list of files. `-m u:NAME:rwx,g::r-x` adds or changes entries, `-x u:NAME` removes them, `--set` replaces the list (it needs `u::`, `g::` and `o::`), `-M`, `-X` and `--set-file` read the entries from a file, `-b` removes every extended entry, `-k` removes the default list, `-d` makes the other options act on the default list (a directory only; `d:` in an entry does the same), `-n` leaves the mask alone and `-R` recurses. Permissions are `rwx`, `r-x`, `---` or an octal digit. The mask is recalculated unless `-n` or an explicit `m::` is given, and the mode shows the owner, the mask (as the group bits) and the others, as on Linux.

An entry is recorded and shown by `getfacl` but is not consulted by ecmaOS's permission checks, which use the mode.

## Examples

```
setfacl -m u:alice:rw file
setfacl -d -m g:staff:rx dir
setfacl -b file
```

## See also

`@ecmaos/coreutils/getfacl`, `@ecmaos/coreutils/chmod`, `@ecmaos/coreutils/setfattr`

## License

MIT OR Apache-2.0.
