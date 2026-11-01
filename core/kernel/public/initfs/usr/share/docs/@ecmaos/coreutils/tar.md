# tar

`man @ecmaos/coreutils/tar`

## Synopsis

```
tar [OPTION]... [FILE]...
```

## Description

Create, extract, or list tar archives.

## Options

```
  -c, --create    create a new archive
  -x, --extract   extract files from an archive
  -t, --list      list the contents of an archive
  -f, --file      use archive file (required for create, optional for extract/list - uses stdin if omitted)
  -z, --gzip      filter the archive through gzip
  -j, --bzip2     filter the archive through bzip2
  -J, --xz        filter the archive through xz
      --lzma      filter the archive through xz --format=lzma
      --zstd      filter the archive through zstd
  -I, --use-compress-program=PROG   filter through PROG (it must accept -d)
  -a, --auto-compress   pick the compression by the archive's suffix
  -v, --verbose   verbosely list files processed
  -C, --directory change to directory before extracting
  -h, --help      display this help and exit

The options may be given without a dash as the first word: tar czf out.tgz dir
```

`--acls` stores each member's ACLs in `SCHILY.acl.access` and `SCHILY.acl.default` pax records (and uses the pax format) and restores them on extraction; `--no-acls` is the default.

## Compression

gzip is built in. The others run the program of that name as a filter (`bzip2`, `xz` and `zstd` ship with `@ecmaos/coreutils`), and `-I` runs any program on `PATH` that reads standard input, writes standard output, and decompresses with `-d`. A compressed archive is recognized by its first bytes when it is read, so `tar xf a.tar.xz` needs no option; lzma has no reliable mark, so it is read by the `.lzma` or `.tlz` suffix or with `--lzma`. A compressed archive cannot be appended to, updated or deleted from.

## Backing up the machine

A machine's files are the only state it has, so an archive of them is a backup. Take one, hand it to the browser as a download, and bring it back with `upload`:

```
tar czf /tmp/backup.tgz /etc /home /root
download /tmp/backup.tgz
upload                         # pick the file; it lands in the current directory
tar xzf backup.tgz -C /
```
