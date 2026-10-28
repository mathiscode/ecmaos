# sync

`man @ecmaos/coreutils/sync`

## Synopsis

```
sync [-d|-f] [FILE]...
```

## Description

Write out what the filesystems hold. With no FILE, every mounted filesystem is asked to flush. With FILEs, each one is flushed (`fsync`), only its data with `-d` (`fdatasync`), or the filesystem it is on with `-f`.

The IndexedDB root commits each write as it is made, so there is rarely anything left for `sync` to do. A backend that buffers writes, such as a remote mount, is told to write them out.

## Options

```
  -d, --data         sync only file data
  -f, --file-system  sync the file systems that hold the files
```

## See also

`mount`, `df`
