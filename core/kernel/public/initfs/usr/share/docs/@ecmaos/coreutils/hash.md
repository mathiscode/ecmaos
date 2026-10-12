# hash

`man @ecmaos/coreutils/hash`

## Synopsis

```
hash [-lr] [-p PATHNAME] [-dt] [NAME ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. bash remembers where it found each command. This shell looks every command up in `$PATH` each time, so there is nothing to remember: `hash` with no argument says `hash: hash table empty`, `hash NAME` checks that NAME can be found, and `-p` is refused because a location cannot be pinned. A change to `$PATH` therefore always takes effect at once.

## Options

- `-r` - forget all remembered locations (nothing to do)
- `-d` - forget NAME; always `not found`, since nothing was remembered
- `-l` - list in a form that can be read back (an empty list)
- `-t` - print the path of each NAME (a file on `$PATH`)
- `-p PATHNAME` - refused

## Exit status

0, or 1 when a NAME is not found.

## See also

`type`, `command`
