# mkfifo

`man @ecmaos/coreutils/mkfifo`

## Synopsis

```
mkfifo [-m MODE] NAME...
```

## Description

Create named pipes (FIFOs) with the given NAMEs. A new FIFO gets 0666 less the umask; `-m` sets the permission bits exactly.

Opening a FIFO for reading waits until another process opens it for writing, and the other way round, as on Linux. Opening it for both reading and writing does not wait. The data in a FIFO lives in memory and is dropped when the last descriptor for it closes.

## Options

```
  -m, --mode=MODE    set file permission bits to MODE, not a=rw - umask
      --help         display this help and exit
      --version      output version information and exit
```

## Example

```
mkfifo /tmp/log
cat /tmp/log &
echo hello > /tmp/log
```
