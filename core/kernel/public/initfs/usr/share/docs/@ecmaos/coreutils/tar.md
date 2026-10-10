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
  -v, --verbose   verbosely list files processed
  -C, --directory change to directory before extracting
  -h, --help      display this help and exit

The options may be given without a dash as the first word: tar czf out.tgz dir
```

## Backing up the machine

A machine's files are the only state it has, so an archive of them is a backup. Take one, hand it to the browser as a download, and bring it back with `upload`:

```
tar czf /tmp/backup.tgz /etc /home /root
download /tmp/backup.tgz
upload                         # pick the file; it lands in the current directory
tar xzf backup.tgz -C /
```

## See also

`tar --help`
