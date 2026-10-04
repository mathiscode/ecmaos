# groupdel

`man @ecmaos/kernel/commands/groupdel`

## Synopsis

```
groupdel GROUP
```

## Description

Deletes a group. It refuses while the group is the primary group of a user; members of a group that is deleted simply stop being in it.

## Notes

Only root may run it.

## Exit status

0 on success, 1 when the group could not be removed, 2 for a bad command line.

## See also

`@ecmaos/kernel/commands/groupadd`, `@ecmaos/kernel/commands/groupmod`
