# getfacl

`man @ecmaos/coreutils/getfacl`

## Synopsis

```
getfacl [-acdeEnpsRLP] file ...
```

## Description

Shows the access control list of each file: the owner and group, then the entries (`user::`, `user:NAME:`, `group::`, `group:NAME:`, `mask::`, `other::`), and for a directory its `default:` entries. A file with no ACL shows the entries its mode stands for. `-a` shows the access list only, `-d` the default list only, `-c` leaves out the header, `-n` prints numeric ids, `-e` and `-E` show or hide `#effective:` where the mask takes rights away, `-s` skips files with only the base entries and `-R` recurses.

The lists are kept in the `system.posix_acl_access` and `system.posix_acl_default` attributes in Linux's format, so they are stored and shown as on Linux. The filesystem's permission check honours them as Linux does: the owner is judged by `user::`, a named user by its entry limited by the mask, the group class by the best matching group entry limited by the mask, everyone else by `other::`; root bypasses. The mask is the group bits of the mode, so `chmod g-w` also narrows named entries. A new file in a directory with a default ACL starts with it, and the umask is not applied. A filesystem that cannot keep extended attributes refuses `setfacl` with "Operation not supported".

## Examples

```
getfacl file
getfacl -R dir
getfacl -cd dir
```

## See also

`@ecmaos/coreutils/setfacl`, `@ecmaos/coreutils/getfattr`, `@ecmaos/coreutils/chmod`

## License

MIT OR Apache-2.0.
