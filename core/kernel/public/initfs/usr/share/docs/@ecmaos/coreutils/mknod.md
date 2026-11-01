# mknod

`man @ecmaos/coreutils/mknod`

## Synopsis

```
mknod [-m MODE] NAME TYPE [MAJOR MINOR]
```

## Description

Create the special file NAME of the given TYPE. Only `p`, a named pipe, can be made here; it is what `mkfifo` makes. The device types `b`, `c` and `u` are refused with "Operation not permitted": the kernel's drivers make the device nodes under `/dev`, not a command.

## Options

```
  -m, --mode=MODE    set file permission bits to MODE, not a=rw - umask
      --help         display this help and exit
      --version      output version information and exit
```
