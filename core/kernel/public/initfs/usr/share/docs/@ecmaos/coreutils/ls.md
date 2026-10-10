# ls

`man @ecmaos/coreutils/ls`

## Synopsis

```
ls [OPTION]... [FILE]...
```

## Description

List information about the FILEs (the current directory by default), sorted by name. Entries starting with
`.` are left out unless `-a` or `-A` is given.

On a terminal the names are laid out in columns, filled down; when the output goes to a file or a pipe there is
one name per line, so `ls | wc -l` counts entries.

With a directory operand its contents are listed; with a file operand just that file. Files come first, then each
directory, with a `name:` header before each when there is more than one operand or `-R` is given. A symbolic
link to a directory is followed unless `-l` or `-d` is given.

## Long format

`-l` prints one line per entry:

```
-rw-r--r-- 1 root root 5 Oct  3 09:05 a.txt
```

The type and permission characters (`d` directory, `l` link, `c` and `b` device, `p` fifo, `s` socket; setuid,
setgid and the sticky bit show as `s`, `S`, `t`, `T`), the link count, the owner and group (names from
`/etc/passwd` and `/etc/group`, the number when there is no entry), the size (or `major, minor` for a device),
the modification time (the year instead of the time for a file older than six months), and the name, followed by
`-> target` for a symbolic link. A `total` line gives the blocks used, in KiB.

## Options

- `-a`, `--all`: do not ignore entries starting with `.`.
- `-A`, `--almost-all`: like `-a`, but leave out `.` and `..`.
- `-d`, `--directory`: list directories themselves, not their contents.
- `-F`, `--classify`: append an indicator to entries: `/` directory, `*` executable, `@` link, `|` fifo, `=` socket.
- `-p`: append `/` to directories.
- `-h`, `--human-readable`: with `-l`, print sizes like `1.5K`, `234M`.
- `-i`, `--inode`: print the inode number of each entry.
- `-l`: use the long listing format.
- `-1`: list one entry per line.
- `-r`, `--reverse`: reverse the sort order.
- `-R`, `--recursive`: list subdirectories recursively.
- `-S`: sort by size, largest first.
- `-t`: sort by modification time, newest first.
- `-U`: do not sort; list in directory order.
- `--help`: show usage.

## Exit status

0 normally; 2 if an operand cannot be read; 1 if a subdirectory of a recursive listing cannot.

## See also

`stat`, `find`

## Color

`--color[=WHEN]` colors each name by what it is, as GNU `ls` does: directories blue, links cyan, executables green, archives red, images and video magenta, audio cyan, and the setuid, setgid, sticky and world-writable cases with their own backgrounds. `WHEN` is `always` (also what a bare `--color` means), `auto` (only when standard output is a terminal) or `never`. `$LS_COLORS` replaces the defaults (`di=01;34:*.tar=01;31:...`). Only the name is colored, so `-l` and the columns still line up. The default `.bashrc` in `/etc/skel` aliases `ls` to `ls --color=auto`.
