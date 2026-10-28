# hostname

`man @ecmaos/coreutils/hostname`

## Synopsis

```
hostname [-f|-s]
hostname NAME
hostname -F FILE
```

## Description

Show or set the system's host name. It is the kernel's, `/proc/sys/kernel/hostname` (what `uname -n` prints), which boot takes from `/etc/hostname`.

Setting it is root's and lasts until the next boot, as on Linux. To keep a name across boots use `hostnamectl set-hostname`, which also writes `/etc/hostname`.

## Options

```
  -f, --fqdn              print the FQDN (Fully Qualified Domain Name)
  -s, --short             print the short hostname
  -F, --file FILE         set the host name from the first line of FILE
  --help                  display this help and exit
```

## See also

`hostnamectl`, `uname`
